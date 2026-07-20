import { CommandCenterError } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";

import { ProcessRunner } from "../processRunner.ts";

const PYTHON_ENTRYPOINT = "/usr/bin/python3";
const SAFE_PYTHON_PATH = /^\/usr\/bin\/python3(?:\.[0-9]+)*$/u;
const PYTHON_PREFLIGHT = String.raw`
import ctypes
import os
import sys
import tempfile

libc = ctypes.CDLL(None, use_errno=True)
renameat2 = getattr(libc, "renameat2", None)
if renameat2 is None:
    sys.exit(78)
renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int
with tempfile.TemporaryDirectory(prefix="command-center-renameat2-") as directory:
    left = os.path.join(directory, "left")
    right = os.path.join(directory, "right")
    with open(left, "xb") as stream:
        stream.write(b"left")
        stream.flush()
        os.fsync(stream.fileno())
    with open(right, "xb") as stream:
        stream.write(b"right")
        stream.flush()
        os.fsync(stream.fileno())
    if renameat2(-100, os.fsencode(left), -100, os.fsencode(right), 2) != 0:
        sys.exit(79)
    if open(left, "rb").read() != b"right" or open(right, "rb").read() != b"left":
        sys.exit(80)
sys.stdout.write("renameat2-ready\n")
`;

const PYTHON_DIRECTORY_FSYNC = String.raw`
import json
import os
import stat
import sys

request = json.loads(sys.stdin.read())
directory = request.get("directory")
expected = request.get("expected")
if not isinstance(directory, str) or not os.path.isabs(directory) or not isinstance(expected, dict):
    raise RuntimeError("Invalid directory durability request")

flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
if hasattr(os, "O_NOFOLLOW"):
    flags |= os.O_NOFOLLOW
fd = os.open(directory, flags)
try:
    before = os.fstat(fd)
    canonical_before = os.stat(directory, follow_symlinks=False)
    if not stat.S_ISDIR(before.st_mode) or not stat.S_ISDIR(canonical_before.st_mode):
        raise RuntimeError("Durability target is not a directory")
    if (
        str(before.st_dev) != str(expected.get("dev"))
        or str(before.st_ino) != str(expected.get("ino"))
        or before.st_dev != canonical_before.st_dev
        or before.st_ino != canonical_before.st_ino
    ):
        raise RuntimeError("Directory identity changed before durability sync")
    os.fsync(fd)
    after = os.fstat(fd)
    canonical_after = os.stat(directory, follow_symlinks=False)
    if (
        after.st_dev != before.st_dev
        or after.st_ino != before.st_ino
        or canonical_after.st_dev != before.st_dev
        or canonical_after.st_ino != before.st_ino
    ):
        raise RuntimeError("Directory identity changed during durability sync")
finally:
    os.close(fd)
sys.stdout.write("fsync-directory-ready\n")
`;

/**
 * Security boundary for service-owned automation bytes.  The TypeScript
 * caller may resolve and inspect paths, but this helper alone creates
 * recovery storage and publishes target/index bytes.  Every filesystem
 * mutation is relative to identity-pinned directory descriptors.
 */
const PYTHON_AUTHORING_TRANSACTION = String.raw`
import base64
import ctypes
import errno
import hashlib
import json
import os
import stat
import sys
import time

RENAME_NOREPLACE = 1
RENAME_EXCHANGE = 2
PHASE = "decode"
MUTATED = False
EXCHANGED = False
OWNED_LOCK = None
COMMITTED = False
AUTHORED_IDENTITY = None
ORIGINAL_IDENTITY = None
GIT_FD = None
ROOT_FD = None
RECOVERY_FD = None
TARGET_FD = None
request = {}

def fail(message):
    raise RuntimeError(message)

def valid_name(value):
    return (
        isinstance(value, str)
        and value not in ("", ".", "..")
        and "/" not in value
        and "\\" not in value
        and "\x00" not in value
        and len(value.encode("utf-8")) <= 180
    )

def same_identity(actual, expected, include_hash=True):
    if actual is None or expected is None:
        return actual is None and expected is None
    keys = ("dev", "ino", "size", "sha256") if include_hash else ("dev", "ino")
    return all(str(actual.get(key)) == str(expected.get(key)) for key in keys)

def same_contents(actual, expected):
    if actual is None or expected is None:
        return actual is None and expected is None
    return (
        str(actual.get("size")) == str(expected.get("size"))
        and actual.get("sha256") == expected.get("sha256")
    )

def directory_identity(fd):
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode):
        fail("Pinned authoring descriptor is not a directory")
    return {"dev": str(info.st_dev), "ino": str(info.st_ino)}

def canonical_directory_identity(path):
    info = os.stat(path, follow_symlinks=False)
    if not stat.S_ISDIR(info.st_mode):
        fail("Canonical authoring path is not a directory")
    return {"dev": str(info.st_dev), "ino": str(info.st_ino)}

def open_directory(path):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    return os.open(path, flags)

def open_directory_at(parent_fd, name):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    return os.open(name, flags, dir_fd=parent_fd)

def require_private_directory(fd, label):
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode):
        fail(label + " is not a directory")
    if info.st_uid != os.geteuid():
        fail(label + " is not owned by the service user")
    if stat.S_IMODE(info.st_mode) & 0o077:
        fail(label + " grants group or world access")

def file_identity(directory_fd, name):
    flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(name, flags, dir_fd=directory_fd)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            fail("Authoring entry is not a regular file")
        digest = hashlib.sha256()
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        # The directory entry alone is not a durable backup guarantee.  Flush
        # the shared inode before relying on a hard link in recovery storage.
        os.fsync(fd)
        after = os.fstat(fd)
        if (
            before.st_dev != after.st_dev
            or before.st_ino != after.st_ino
            or before.st_size != after.st_size
        ):
            fail("Authoring entry changed while it was hashed")
        return {
            "dev": str(after.st_dev),
            "ino": str(after.st_ino),
            "size": str(after.st_size),
            "sha256": digest.hexdigest(),
        }
    finally:
        os.close(fd)

def optional_file_identity(directory_fd, name):
    try:
        return file_identity(directory_fd, name)
    except FileNotFoundError:
        return None

def renameat2(libc, source_fd, source_name, destination_fd, destination_name, flags):
    function = getattr(libc, "renameat2", None)
    if function is None:
        fail("libc does not expose renameat2")
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    if function(
        source_fd,
        os.fsencode(source_name),
        destination_fd,
        os.fsencode(destination_name),
        flags,
    ) != 0:
        number = ctypes.get_errno()
        fail("renameat2 failed with errno " + str(number))

def write_exact_file(directory_fd, name, payload):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(name, flags, 0o600, dir_fd=directory_fd)
    try:
        offset = 0
        while offset < len(payload):
            written = os.write(fd, payload[offset:])
            if written <= 0:
                fail("Could not write complete authoring bytes")
            offset += written
        os.fsync(fd)
    finally:
        os.close(fd)

def write_manifest(directory_fd, manifest_id, state, document, terminal=False):
    global MUTATED, EXCHANGED, COMMITTED
    if not valid_name(manifest_id) or not valid_name(state):
        fail("Unsafe authoring manifest name")
    if terminal:
        # The data mutation and both parent fsyncs/postflight checks precede
        # this call.  Marker creation itself has an ambiguous failure window,
        # so publication becomes logically committed before any marker I/O.
        MUTATED = False
        EXCHANGED = False
        COMMITTED = True
    final_name = "manifest." + manifest_id + "." + state + ".json"
    temporary = final_name + "." + str(os.getpid()) + ".tmp"
    payload = (json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    write_exact_file(directory_fd, temporary, payload)
    if terminal and request.get("testControl", {}).get("failTerminalAt") == "before_link":
        fail("Injected terminal manifest failure before link")
    os.link(
        temporary,
        final_name,
        src_dir_fd=directory_fd,
        dst_dir_fd=directory_fd,
        follow_symlinks=False,
    )
    if terminal and request.get("testControl", {}).get("failTerminalAt") == "after_link":
        fail("Injected terminal manifest failure after link")
    os.fsync(directory_fd)
    if terminal:
        if request.get("testControl", {}).get("failTerminalAt") == "after_fsync":
            fail("Injected terminal manifest failure after fsync")
        if request.get("testControl", {}).get("crashAt") == "after_complete_manifest":
            os._exit(94)
        try:
            os.unlink(temporary, dir_fd=directory_fd)
            os.fsync(directory_fd)
        except BaseException:
            pass
        return
    os.unlink(temporary, dir_fd=directory_fd)
    os.fsync(directory_fd)

def synchronize(control, point):
    if not isinstance(control, dict):
        return
    selected = control.get("pauseAt")
    if selected is None:
        selected = "before_mutation"
    if selected != point:
        return
    ready = control.get("readyPath")
    proceed = control.get("continuePath")
    if ready is None and proceed is None:
        return
    if not isinstance(ready, str) or not isinstance(proceed, str):
        fail("Both authoring synchronization paths are required")
    ready_fd = os.open(ready, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    os.close(ready_fd)
    deadline = time.monotonic() + 10.0
    while not os.path.exists(proceed):
        if time.monotonic() >= deadline:
            fail("Timed out waiting for the authoring test continuation")
        time.sleep(0.005)

def fsync_directories(*directory_fds):
    seen = set()
    for directory_fd in directory_fds:
        if directory_fd is None or directory_fd in seen:
            continue
        os.fsync(directory_fd)
        seen.add(directory_fd)

def compensating_exchange(
    libc,
    left_fd,
    left_name,
    right_fd,
    right_name,
    expected_left,
    expected_right,
    control_point,
    label,
):
    """Exchange exact entries or restore any concurrent entries displaced by it."""
    if not same_identity(optional_file_identity(left_fd, left_name), expected_left) or not same_identity(
        optional_file_identity(right_fd, right_name), expected_right
    ):
        fail(label + " entries changed before the final compensating check")
    synchronize(request.get("testControl", {}), control_point)
    renameat2(libc, left_fd, left_name, right_fd, right_name, RENAME_EXCHANGE)
    fsync_directories(left_fd, right_fd)

    exchanged_left = optional_file_identity(left_fd, left_name)
    exchanged_right = optional_file_identity(right_fd, right_name)
    if same_identity(exchanged_left, expected_right) and same_identity(
        exchanged_right, expected_left
    ):
        return exchanged_left, exchanged_right

    # RENAME_EXCHANGE cannot lose an entry, but a replacement in the final
    # check-to-syscall gap can put the wrong entries on the opposite paths.
    # Reverse only the exact post-syscall pair we observed.  If either path
    # changes again, leave every object at its current named path for recovery.
    if exchanged_left is None or exchanged_right is None:
        fail(label + " produced an incomplete named exchange state")
    if not same_identity(
        optional_file_identity(left_fd, left_name), exchanged_left
    ) or not same_identity(optional_file_identity(right_fd, right_name), exchanged_right):
        fsync_directories(left_fd, right_fd)
        fail(label + " entries changed before concurrent-entry restoration")
    renameat2(libc, left_fd, left_name, right_fd, right_name, RENAME_EXCHANGE)
    fsync_directories(left_fd, right_fd)
    restored_left = optional_file_identity(left_fd, left_name)
    restored_right = optional_file_identity(right_fd, right_name)
    if same_identity(restored_left, exchanged_right) and same_identity(
        restored_right, exchanged_left
    ):
        fail(label + " displaced concurrent entries; their exact paths were restored")
    fail(label + " could not verify exact concurrent-entry restoration")

def compensating_move_noreplace(
    libc,
    source_fd,
    source_name,
    destination_fd,
    destination_name,
    expected_source,
    control_point,
    label,
):
    """Move an exact entry or restore a concurrent entry moved in the final gap."""
    if not same_identity(optional_file_identity(source_fd, source_name), expected_source):
        fail(label + " source changed before the final compensating check")
    if optional_file_identity(destination_fd, destination_name) is not None:
        fail(label + " destination changed before the final compensating check")
    synchronize(request.get("testControl", {}), control_point)
    renameat2(
        libc,
        source_fd,
        source_name,
        destination_fd,
        destination_name,
        RENAME_NOREPLACE,
    )
    fsync_directories(source_fd, destination_fd)

    remaining_source = optional_file_identity(source_fd, source_name)
    moved_entry = optional_file_identity(destination_fd, destination_name)
    if remaining_source is None and same_identity(moved_entry, expected_source):
        return moved_entry

    # A source replacement in the last gap may have been moved.  Put that exact
    # object back with NOREPLACE.  If a newer source now occupies the name, keep
    # both objects at their distinct named paths and stop for manual recovery.
    if remaining_source is None and moved_entry is not None:
        if optional_file_identity(source_fd, source_name) is not None or not same_identity(
            optional_file_identity(destination_fd, destination_name), moved_entry
        ):
            fsync_directories(source_fd, destination_fd)
            fail(label + " entries changed before concurrent-entry restoration")
        try:
            renameat2(
                libc,
                destination_fd,
                destination_name,
                source_fd,
                source_name,
                RENAME_NOREPLACE,
            )
        except BaseException:
            fsync_directories(source_fd, destination_fd)
            fail(label + " could not restore the displaced entry without replacement")
        fsync_directories(source_fd, destination_fd)
        restored_source = optional_file_identity(source_fd, source_name)
        restored_destination = optional_file_identity(destination_fd, destination_name)
        if same_identity(restored_source, moved_entry) and restored_destination is None:
            fail(label + " displaced a concurrent entry; its exact path was restored")
        fail(label + " could not verify exact concurrent-entry restoration")

    fsync_directories(source_fd, destination_fd)
    fail(label + " produced an unexpected named move state")

def decode_contents():
    encoded = request.get("contentsBase64")
    if not isinstance(encoded, str):
        fail("Missing authoring contents")
    try:
        contents = base64.b64decode(encoded, validate=True)
    except BaseException:
        fail("Authoring contents are not valid base64")
    expected_size = request.get("expectedContentsSize")
    expected_digest = request.get("expectedContentsSha256")
    if str(len(contents)) != str(expected_size) or hashlib.sha256(contents).hexdigest() != expected_digest:
        fail("Authoring contents failed their transport digest")
    return contents

def validate_pinned_directory(fd, path, expected, label):
    actual = directory_identity(fd)
    if not same_identity(actual, expected, False):
        fail(label + " identity changed")
    if not same_identity(canonical_directory_identity(path), actual, False):
        fail("Canonical " + label + " path does not match its pinned descriptor")
    return actual

def safe_copy(source_fd, source_name, destination_fd, destination_name):
    read_flags = os.O_RDONLY | os.O_CLOEXEC
    write_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        read_flags |= os.O_NOFOLLOW
        write_flags |= os.O_NOFOLLOW
    input_fd = os.open(source_name, read_flags, dir_fd=source_fd)
    output_fd = None
    try:
        before = os.fstat(input_fd)
        if not stat.S_ISREG(before.st_mode):
            fail("Recovery copy source is not a regular file")
        os.fsync(input_fd)
        output_fd = os.open(destination_name, write_flags, 0o600, dir_fd=destination_fd)
        digest = hashlib.sha256()
        total = 0
        while True:
            chunk = os.read(input_fd, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            total += len(chunk)
            offset = 0
            while offset < len(chunk):
                written = os.write(output_fd, chunk[offset:])
                if written <= 0:
                    fail("Could not write a complete independent recovery copy")
                offset += written
        os.fsync(output_fd)
        after = os.fstat(input_fd)
        if (
            before.st_dev != after.st_dev
            or before.st_ino != after.st_ino
            or before.st_size != after.st_size
            or before.st_mtime_ns != after.st_mtime_ns
            or before.st_ctime_ns != after.st_ctime_ns
            or total != after.st_size
        ):
            fail("Recovery copy source changed while it was copied")
        copied = file_identity(destination_fd, destination_name)
        if copied["size"] != str(total) or copied["sha256"] != digest.hexdigest():
            fail("Independent recovery copy failed digest verification")
        return copied
    finally:
        if output_fd is not None:
            os.close(output_fd)
        os.close(input_fd)

def prepare_recovery():
    global PHASE, GIT_FD, ROOT_FD, RECOVERY_FD
    if not valid_name(request.get("rootName")) or not valid_name(request.get("transactionPrefix")):
        fail("Recovery names must be safe path components")
    git_path = request.get("gitDirectory")
    if not isinstance(git_path, str) or not os.path.isabs(git_path):
        fail("Recovery Git directory must be absolute")

    PHASE = "open_git_directory"
    GIT_FD = open_directory(git_path)
    git_identity = validate_pinned_directory(
        GIT_FD, git_path, request.get("expectedGitDirectory"), "Git directory"
    )

    PHASE = "create_recovery_root"
    root_name = request["rootName"]
    try:
        os.mkdir(root_name, 0o700, dir_fd=GIT_FD)
    except FileExistsError:
        pass
    ROOT_FD = open_directory_at(GIT_FD, root_name)
    require_private_directory(ROOT_FD, "Automation recovery root")
    root_identity = directory_identity(ROOT_FD)
    os.fsync(ROOT_FD)
    os.fsync(GIT_FD)

    synchronize(request.get("testControl", {}), "after_recovery_root_open")
    PHASE = "verify_recovery_root"
    root_path = os.path.join(git_path, root_name)
    if not same_identity(canonical_directory_identity(git_path), git_identity, False):
        fail("Canonical Git directory changed during recovery allocation")
    if not same_identity(canonical_directory_identity(root_path), root_identity, False):
        fail("Canonical automation recovery root changed during allocation")

    PHASE = "create_recovery_transaction"
    prefix = request["transactionPrefix"]
    transaction_name = None
    for _ in range(128):
        candidate = prefix + os.urandom(16).hex()
        try:
            os.mkdir(candidate, 0o700, dir_fd=ROOT_FD)
            transaction_name = candidate
            break
        except FileExistsError:
            continue
    if transaction_name is None:
        fail("Could not allocate a unique automation recovery transaction")
    RECOVERY_FD = open_directory_at(ROOT_FD, transaction_name)
    require_private_directory(RECOVERY_FD, "Automation recovery transaction")
    recovery_identity = directory_identity(RECOVERY_FD)
    os.fsync(RECOVERY_FD)
    os.fsync(ROOT_FD)
    os.fsync(GIT_FD)

    PHASE = "verify_recovery_transaction"
    transaction_path = os.path.join(root_path, transaction_name)
    if not same_identity(canonical_directory_identity(git_path), git_identity, False):
        fail("Canonical Git directory changed after recovery allocation")
    if not same_identity(canonical_directory_identity(root_path), root_identity, False):
        fail("Canonical automation recovery root changed after allocation")
    if not same_identity(canonical_directory_identity(transaction_path), recovery_identity, False):
        fail("Canonical automation recovery transaction changed after allocation")
    return {
        "ok": True,
        "operation": "prepare-recovery",
        "phase": "complete",
        "recoveryRoot": root_path,
        "recoveryRootIdentity": root_identity,
        "recoveryDirectory": transaction_path,
        "recoveryDirectoryIdentity": recovery_identity,
    }

def publish_contents():
    global PHASE, MUTATED, AUTHORED_IDENTITY, ORIGINAL_IDENTITY, TARGET_FD, RECOVERY_FD
    mode = request.get("mode")
    if mode not in ("create", "update"):
        fail("Unsupported target publication mode")
    for key in ("manifestId", "targetName", "recoveryName"):
        if not valid_name(request.get(key)):
            fail("Target publication names must be safe path components")
    contents = decode_contents()
    target_path = request.get("targetDirectory")
    recovery_path = request.get("recoveryDirectory")
    if not isinstance(target_path, str) or not os.path.isabs(target_path):
        fail("Target publication directory must be absolute")
    if not isinstance(recovery_path, str) or not os.path.isabs(recovery_path):
        fail("Target recovery directory must be absolute")

    PHASE = "open_directories"
    TARGET_FD = open_directory(target_path)
    RECOVERY_FD = open_directory(recovery_path)
    target_directory = validate_pinned_directory(
        TARGET_FD, target_path, request.get("expectedTargetDirectory"), "target directory"
    )
    recovery_directory = validate_pinned_directory(
        RECOVERY_FD, recovery_path, request.get("expectedRecoveryDirectory"), "recovery directory"
    )
    require_private_directory(RECOVERY_FD, "Automation recovery transaction")

    PHASE = "stage_contents"
    recovery_name = request["recoveryName"]
    target_name = request["targetName"]
    write_exact_file(RECOVERY_FD, recovery_name, contents)
    authored = file_identity(RECOVERY_FD, recovery_name)
    AUTHORED_IDENTITY = authored
    if (
        authored["sha256"] != request.get("expectedContentsSha256")
        or authored["size"] != str(request.get("expectedContentsSize"))
    ):
        fail("Staged automation bytes do not match their intended digest")
    authored_backup = "backup." + request["manifestId"] + ".authored"
    safe_copy(RECOVERY_FD, recovery_name, RECOVERY_FD, authored_backup)

    original = optional_file_identity(TARGET_FD, target_name)
    ORIGINAL_IDENTITY = original
    original_backup = None
    if mode == "create":
        if original is not None:
            fail("The new automation target already exists")
    else:
        if not same_identity(original, request.get("expectedTarget")):
            fail("The automation target changed before publication")
        original_backup = "backup." + request["manifestId"] + ".target"
        safe_copy(TARGET_FD, target_name, RECOVERY_FD, original_backup)
    os.fsync(RECOVERY_FD)
    if not same_contents(file_identity(RECOVERY_FD, authored_backup), authored):
        fail("Durable authored backup does not match staged bytes")
    if original_backup is not None and not same_contents(
        file_identity(RECOVERY_FD, original_backup), original
    ):
        fail("Durable target backup does not match the original target")

    PHASE = "prepared_manifest"
    write_manifest(
        RECOVERY_FD,
        request["manifestId"],
        "prepared",
        {
            "schemaVersion": 1,
            "state": "prepared",
            "operation": "publish-contents",
            "mode": mode,
            "targetDirectory": target_path,
            "targetName": target_name,
            "targetDirectoryIdentity": target_directory,
            "recoveryDirectory": recovery_path,
            "recoveryDirectoryIdentity": recovery_directory,
            "authored": authored,
            "original": original,
            "authoredBackupName": authored_backup,
            "originalBackupName": original_backup,
        },
    )

    synchronize(request.get("testControl", {}), "before_mutation")
    PHASE = "last_identity_check"
    if not same_identity(canonical_directory_identity(target_path), target_directory, False):
        fail("Canonical target directory changed immediately before publication")
    if not same_identity(canonical_directory_identity(recovery_path), recovery_directory, False):
        fail("Canonical recovery directory changed immediately before publication")
    if not same_identity(file_identity(RECOVERY_FD, recovery_name), authored):
        fail("Staged automation changed immediately before publication")
    if not same_identity(optional_file_identity(TARGET_FD, target_name), original):
        fail("Automation target changed immediately before publication")
    synchronize(request.get("testControl", {}), "after_target_last_check")

    PHASE = "publish"
    libc = ctypes.CDLL(None, use_errno=True)
    if mode == "create":
        renameat2(libc, RECOVERY_FD, recovery_name, TARGET_FD, target_name, RENAME_NOREPLACE)
    else:
        renameat2(libc, RECOVERY_FD, recovery_name, TARGET_FD, target_name, RENAME_EXCHANGE)
    MUTATED = True
    synchronize(request.get("testControl", {}), "after_target_mutation")
    if request.get("testControl", {}).get("crashAt") == "after_target_mutation":
        os._exit(92)
    os.fsync(TARGET_FD)
    os.fsync(RECOVERY_FD)
    if request.get("testControl", {}).get("failAfterTargetMutation"):
        fail("Injected target failure after durable mutation")

    PHASE = "postflight"
    published = file_identity(TARGET_FD, target_name)
    if not same_identity(published, authored):
        fail("Published automation does not match the staged bytes")
    displaced = optional_file_identity(RECOVERY_FD, recovery_name)
    if not same_identity(displaced, original):
        fail("Displaced automation does not match the original target")
    if not same_identity(canonical_directory_identity(target_path), target_directory, False):
        fail("Canonical target directory changed during publication")
    if not same_identity(canonical_directory_identity(recovery_path), recovery_directory, False):
        fail("Canonical recovery directory changed during publication")

    PHASE = "complete_manifest"
    write_manifest(
        RECOVERY_FD,
        request["manifestId"],
        "complete",
        {
            "schemaVersion": 1,
            "state": "complete",
            "operation": "publish-contents",
            "mode": mode,
            "target": published,
            "recovery": displaced,
        },
        terminal=True,
    )
    return {
        "ok": True,
        "operation": "publish-contents",
        "phase": "complete",
        "mode": mode,
        "target": published,
        "recovery": displaced,
    }

def preserve_created():
    global PHASE, MUTATED, AUTHORED_IDENTITY, TARGET_FD, RECOVERY_FD
    for key in ("manifestId", "sourceName", "recoveryName"):
        if not valid_name(request.get(key)):
            fail("Created-target preservation names must be safe path components")
    source_path = request.get("sourceDirectory")
    recovery_path = request.get("recoveryDirectory")
    if not isinstance(source_path, str) or not os.path.isabs(source_path):
        fail("Created-target source directory must be absolute")
    if not isinstance(recovery_path, str) or not os.path.isabs(recovery_path):
        fail("Created-target recovery directory must be absolute")

    PHASE = "open_directories"
    TARGET_FD = open_directory(source_path)
    RECOVERY_FD = open_directory(recovery_path)
    source_directory = validate_pinned_directory(
        TARGET_FD, source_path, request.get("expectedSourceDirectory"), "source directory"
    )
    recovery_directory = validate_pinned_directory(
        RECOVERY_FD, recovery_path, request.get("expectedRecoveryDirectory"), "recovery directory"
    )
    require_private_directory(RECOVERY_FD, "Automation recovery transaction")
    source_name = request["sourceName"]
    recovery_name = request["recoveryName"]
    source = file_identity(TARGET_FD, source_name)
    AUTHORED_IDENTITY = source
    if not same_identity(source, request.get("expectedSource")):
        fail("Created automation changed before preservation")

    PHASE = "preserve_source"
    backup_name = "backup." + request["manifestId"] + ".source"
    safe_copy(TARGET_FD, source_name, RECOVERY_FD, backup_name)
    os.fsync(RECOVERY_FD)
    if not same_contents(file_identity(RECOVERY_FD, backup_name), source):
        fail("Durable created-target backup does not match its source")
    write_manifest(
        RECOVERY_FD,
        request["manifestId"],
        "prepared",
        {
            "schemaVersion": 1,
            "state": "prepared",
            "operation": "preserve-created",
            "sourceDirectory": source_path,
            "sourceDirectoryIdentity": source_directory,
            "sourceName": source_name,
            "recoveryDirectory": recovery_path,
            "recoveryDirectoryIdentity": recovery_directory,
            "recoveryName": recovery_name,
            "source": source,
            "backupName": backup_name,
        },
    )

    synchronize(request.get("testControl", {}), "before_preserve_last_check")
    PHASE = "last_identity_check"
    if not same_identity(file_identity(TARGET_FD, source_name), source):
        fail("Created automation changed immediately before preservation")
    if optional_file_identity(RECOVERY_FD, recovery_name) is not None:
        fail("Created-target recovery destination already exists")
    if not same_identity(canonical_directory_identity(source_path), source_directory, False):
        fail("Canonical created-target source directory changed before preservation")
    if not same_identity(canonical_directory_identity(recovery_path), recovery_directory, False):
        fail("Canonical created-target recovery directory changed before preservation")
    synchronize(request.get("testControl", {}), "after_preserve_last_check")

    PHASE = "preserve"
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2(libc, TARGET_FD, source_name, RECOVERY_FD, recovery_name, RENAME_NOREPLACE)
    MUTATED = True
    synchronize(request.get("testControl", {}), "after_preserve_move")
    os.fsync(TARGET_FD)
    os.fsync(RECOVERY_FD)
    if request.get("testControl", {}).get("failAfterPreserveMove"):
        fail("Injected preservation failure after durable move")
    if optional_file_identity(TARGET_FD, source_name) is not None:
        fail("Created automation pathname remains after preservation")
    recovered = file_identity(RECOVERY_FD, recovery_name)
    if not same_identity(recovered, source):
        fail("Recovered created automation does not match its source")
    if not same_identity(canonical_directory_identity(source_path), source_directory, False):
        fail("Canonical created-target source directory changed during preservation")
    if not same_identity(canonical_directory_identity(recovery_path), recovery_directory, False):
        fail("Canonical created-target recovery directory changed during preservation")

    PHASE = "complete_manifest"
    write_manifest(
        RECOVERY_FD,
        request["manifestId"],
        "complete",
        {
            "schemaVersion": 1,
            "state": "complete",
            "operation": "preserve-created",
            "recovery": recovered,
        },
        terminal=True,
    )
    return {
        "ok": True,
        "operation": "preserve-created",
        "phase": "complete",
        "recovery": recovered,
    }

def publish_index():
    global PHASE, EXCHANGED, OWNED_LOCK, AUTHORED_IDENTITY, ORIGINAL_IDENTITY, GIT_FD, RECOVERY_FD
    for key in ("manifestId", "indexName", "lockName"):
        if not valid_name(request.get(key)):
            fail("Index publication names must be safe path components")
    contents = decode_contents()
    git_path = request.get("gitDirectory")
    recovery_path = request.get("recoveryDirectory")
    if not isinstance(git_path, str) or not os.path.isabs(git_path):
        fail("Index Git directory must be absolute")
    if not isinstance(recovery_path, str) or not os.path.isabs(recovery_path):
        fail("Index recovery directory must be absolute")

    PHASE = "open_directories"
    GIT_FD = open_directory(git_path)
    RECOVERY_FD = open_directory(recovery_path)
    git_directory = validate_pinned_directory(
        GIT_FD, git_path, request.get("expectedGitDirectory"), "Git directory"
    )
    recovery_directory = validate_pinned_directory(
        RECOVERY_FD, recovery_path, request.get("expectedRecoveryDirectory"), "recovery directory"
    )
    require_private_directory(RECOVERY_FD, "Automation recovery transaction")
    index_name = request["indexName"]
    lock_name = request["lockName"]
    before_index = file_identity(GIT_FD, index_name)
    ORIGINAL_IDENTITY = before_index
    if not same_identity(before_index, request.get("expectedIndex")):
        fail("The private configuration index changed before publication")

    PHASE = "create_and_write_lock"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        lock_fd = os.open(lock_name, flags, 0o600, dir_fd=GIT_FD)
    except FileExistsError:
        fail("The private configuration index is busy")
    try:
        opened = os.fstat(lock_fd)
        if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
            fail("The private configuration index lock is not a unique regular file")
        OWNED_LOCK = {"dev": str(opened.st_dev), "ino": str(opened.st_ino)}
        offset = 0
        while offset < len(contents):
            written = os.write(lock_fd, contents[offset:])
            if written <= 0:
                fail("Could not write the complete private configuration index")
            offset += written
        os.fsync(lock_fd)
    finally:
        os.close(lock_fd)
    authored = file_identity(GIT_FD, lock_name)
    AUTHORED_IDENTITY = authored
    if (
        authored["sha256"] != request.get("expectedContentsSha256")
        or authored["size"] != str(request.get("expectedContentsSize"))
    ):
        fail("Prepared private configuration index failed its intended digest")

    PHASE = "preserve_index_versions"
    original_backup = "backup." + request["manifestId"] + ".index"
    authored_backup = "backup." + request["manifestId"] + ".authored-index"
    safe_copy(GIT_FD, index_name, RECOVERY_FD, original_backup)
    safe_copy(GIT_FD, lock_name, RECOVERY_FD, authored_backup)
    os.fsync(RECOVERY_FD)
    if not same_contents(file_identity(RECOVERY_FD, original_backup), before_index):
        fail("Durable index backup does not match the original index")
    if not same_contents(file_identity(RECOVERY_FD, authored_backup), authored):
        fail("Durable authored-index backup does not match the prepared index")

    PHASE = "prepared_manifest"
    write_manifest(
        RECOVERY_FD,
        request["manifestId"],
        "prepared",
        {
            "schemaVersion": 1,
            "state": "prepared",
            "operation": "publish-index",
            "gitDirectory": git_path,
            "gitDirectoryIdentity": git_directory,
            "recoveryDirectory": recovery_path,
            "recoveryDirectoryIdentity": recovery_directory,
            "indexName": index_name,
            "lockName": lock_name,
            "original": before_index,
            "authored": authored,
            "ownedLockObject": OWNED_LOCK,
            "originalBackupName": original_backup,
            "authoredBackupName": authored_backup,
        },
    )

    synchronize(request.get("testControl", {}), "before_index_exchange")
    PHASE = "last_identity_check"
    if not same_identity(canonical_directory_identity(git_path), git_directory, False):
        fail("Canonical Git directory changed immediately before index publication")
    if not same_identity(canonical_directory_identity(recovery_path), recovery_directory, False):
        fail("Canonical index recovery directory changed immediately before publication")
    if not same_identity(file_identity(GIT_FD, index_name), before_index):
        fail("The private configuration index changed immediately before publication")
    if not same_identity(file_identity(GIT_FD, lock_name), authored):
        fail("The private configuration index lock changed immediately before publication")
    synchronize(request.get("testControl", {}), "after_index_last_check")

    PHASE = "exchange_index"
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2(libc, GIT_FD, lock_name, GIT_FD, index_name, RENAME_EXCHANGE)
    EXCHANGED = True
    os.fsync(GIT_FD)
    synchronize(request.get("testControl", {}), "after_index_exchange")
    if request.get("testControl", {}).get("crashAt") == "after_index_exchange":
        os._exit(93)
    if request.get("testControl", {}).get("failAfterIndexExchange"):
        fail("Injected index failure after durable exchange")

    PHASE = "postflight"
    if not same_identity(file_identity(GIT_FD, index_name), authored):
        fail("Published private configuration index changed after exchange")
    if not same_identity(file_identity(GIT_FD, lock_name), before_index):
        fail("Displaced private configuration index changed after exchange")
    if not same_identity(canonical_directory_identity(git_path), git_directory, False):
        fail("Canonical Git directory changed during index publication")
    if not same_identity(canonical_directory_identity(recovery_path), recovery_directory, False):
        fail("Canonical index recovery directory changed during publication")

    PHASE = "preserve_displaced_index"
    previous_name = "previous-index"
    renameat2(libc, GIT_FD, lock_name, RECOVERY_FD, previous_name, RENAME_NOREPLACE)
    os.fsync(GIT_FD)
    os.fsync(RECOVERY_FD)
    previous = file_identity(RECOVERY_FD, previous_name)
    if not same_identity(previous, before_index):
        fail("Preserved previous index does not match the displaced index")
    if optional_file_identity(GIT_FD, lock_name) is not None:
        fail("Private configuration index lock remains after publication")

    PHASE = "complete_manifest"
    write_manifest(
        RECOVERY_FD,
        request["manifestId"],
        "complete",
        {
            "schemaVersion": 1,
            "state": "complete",
            "operation": "publish-index",
            "index": authored,
            "previousIndex": previous,
        },
        terminal=True,
    )
    return {
        "ok": True,
        "operation": "publish-index",
        "phase": "complete",
        "index": authored,
        "previousIndex": previous,
    }

try:
    request = json.loads(sys.stdin.read())
    operation = request.get("operation")
    if operation == "prepare-recovery":
        result = prepare_recovery()
    elif operation == "publish-contents":
        result = publish_contents()
    elif operation == "preserve-created":
        result = preserve_created()
    elif operation == "publish-index":
        result = publish_index()
    else:
        fail("Unsupported authoring transaction operation")
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
except BaseException as error:
    rollback_error = None
    rolled_back = False
    try:
        operation = request.get("operation") if isinstance(request, dict) else None
        libc = ctypes.CDLL(None, use_errno=True)
        if (
            not COMMITTED
            and operation == "publish-contents"
            and MUTATED
            and TARGET_FD is not None
            and RECOVERY_FD is not None
        ):
            mode = request.get("mode")
            target_name = request.get("targetName")
            recovery_name = request.get("recoveryName")
            authored = request.get("_authored")
            # Recover identities from durable backups because exceptions can
            # occur after any local assignment in publish_contents.
            authored_backup = "backup." + request.get("manifestId", "publish") + ".authored"
            original_backup = "backup." + request.get("manifestId", "publish") + ".target"
            expected_authored = AUTHORED_IDENTITY
            expected_original = ORIGINAL_IDENTITY if mode == "update" else None
            current_target = optional_file_identity(TARGET_FD, target_name)
            current_recovery = optional_file_identity(RECOVERY_FD, recovery_name)
            if mode == "update":
                if same_identity(current_target, expected_authored) and current_recovery is not None:
                    displaced = current_recovery
                    restored_target, recovered_authored = compensating_exchange(
                        libc,
                        TARGET_FD,
                        target_name,
                        RECOVERY_FD,
                        recovery_name,
                        current_target,
                        displaced,
                        "after_compensating_target_last_check",
                        "Target rollback",
                    )
                    if not same_identity(restored_target, displaced) or not same_identity(
                        recovered_authored, expected_authored
                    ):
                        fail("Target rollback identity verification failed")
                    rolled_back = True
                    MUTATED = False
            elif mode == "create":
                if same_identity(current_target, expected_authored) and current_recovery is None:
                    recovered_authored = compensating_move_noreplace(
                        libc,
                        TARGET_FD,
                        target_name,
                        RECOVERY_FD,
                        recovery_name,
                        current_target,
                        "after_compensating_target_last_check",
                        "Created-target rollback",
                    )
                    if optional_file_identity(TARGET_FD, target_name) is not None or not same_identity(
                        recovered_authored, expected_authored
                    ):
                        fail("Created-target rollback identity verification failed")
                    rolled_back = True
                    MUTATED = False
        elif (
            not COMMITTED
            and operation == "preserve-created"
            and MUTATED
            and TARGET_FD is not None
            and RECOVERY_FD is not None
        ):
            source_name = request.get("sourceName")
            recovery_name = request.get("recoveryName")
            current_source = optional_file_identity(TARGET_FD, source_name)
            current_recovery = optional_file_identity(RECOVERY_FD, recovery_name)
            if current_source is None and current_recovery is not None:
                restored_source = compensating_move_noreplace(
                    libc,
                    RECOVERY_FD,
                    recovery_name,
                    TARGET_FD,
                    source_name,
                    current_recovery,
                    "after_compensating_move_last_check",
                    "Created-target preservation rollback",
                )
                if not same_identity(restored_source, current_recovery) or optional_file_identity(
                    RECOVERY_FD, recovery_name
                ) is not None:
                    fail("Created-target compensation failed identity verification")
                rolled_back = True
                MUTATED = False
        elif (
            not COMMITTED
            and operation == "publish-index"
            and GIT_FD is not None
            and RECOVERY_FD is not None
        ):
            manifest_id = request.get("manifestId", "index")
            index_name = request.get("indexName", "index")
            lock_name = request.get("lockName", "index.lock")
            original = ORIGINAL_IDENTITY
            authored = AUTHORED_IDENTITY
            current_index = optional_file_identity(GIT_FD, index_name)
            current_lock = optional_file_identity(GIT_FD, lock_name)
            if EXCHANGED and same_identity(current_index, authored) and current_lock is not None:
                displaced = current_lock
                restored_index, current_lock = compensating_exchange(
                    libc,
                    GIT_FD,
                    index_name,
                    GIT_FD,
                    lock_name,
                    current_index,
                    displaced,
                    "after_compensating_index_last_check",
                    "Index rollback",
                )
                if not same_identity(restored_index, displaced) or not same_identity(
                    current_lock, authored
                ):
                    fail("Index rollback identity verification failed")
                EXCHANGED = False
                rolled_back = True
            elif EXCHANGED and same_identity(current_index, authored) and current_lock is None:
                previous = optional_file_identity(RECOVERY_FD, "previous-index")
                if same_identity(previous, original):
                    recovered_authored, restored_index = compensating_exchange(
                        libc,
                        RECOVERY_FD,
                        "previous-index",
                        GIT_FD,
                        index_name,
                        previous,
                        current_index,
                        "after_compensating_index_last_check",
                        "Preserved-index rollback",
                    )
                    if same_identity(restored_index, previous) and same_identity(
                        recovered_authored, current_index
                    ):
                        EXCHANGED = False
                        rolled_back = True
                        current_index = restored_index
                    else:
                        rollback_error = "Preserved-index rollback identity verification failed"
            # Clear only an exact, freshly observed lock identity.  The move
            # primitive restores a replacement introduced in its final gap.
            if same_identity(current_lock, authored):
                abandoned = "abandoned-index-lock"
                compensating_move_noreplace(
                    libc,
                    GIT_FD,
                    lock_name,
                    RECOVERY_FD,
                    abandoned,
                    current_lock,
                    "after_compensating_lock_last_check",
                    "Authored index-lock cleanup",
                )
                current_lock = None
            elif current_lock is not None and same_identity(current_lock, OWNED_LOCK, False):
                abandoned = "abandoned-index-lock"
                compensating_move_noreplace(
                    libc,
                    GIT_FD,
                    lock_name,
                    RECOVERY_FD,
                    abandoned,
                    current_lock,
                    "after_compensating_lock_last_check",
                    "Owned index-lock cleanup",
                )
                current_lock = None
            elif EXCHANGED and same_identity(current_lock, original):
                displaced = "conflict-previous-index"
                compensating_move_noreplace(
                    libc,
                    GIT_FD,
                    lock_name,
                    RECOVERY_FD,
                    displaced,
                    current_lock,
                    "after_compensating_lock_last_check",
                    "Displaced index-lock cleanup",
                )
                current_lock = None
                EXCHANGED = False
    except BaseException as nested:
        rollback_error = str(nested)

    if RECOVERY_FD is not None and not COMMITTED:
        try:
            manifest_id = request.get("manifestId", "authoring")
            if not valid_name(manifest_id):
                manifest_id = "authoring"
            state = "rolled-back" if rolled_back and rollback_error is None else "conflict"
            write_manifest(
                RECOVERY_FD,
                manifest_id,
                state,
                {
                    "schemaVersion": 1,
                    "state": state,
                    "operation": request.get("operation"),
                    "phase": PHASE,
                    "message": str(error),
                    "mutated": MUTATED,
                    "exchanged": EXCHANGED,
                    "rollbackError": rollback_error,
                },
            )
        except BaseException:
            pass
    print(json.dumps({
        "ok": False,
        "operation": request.get("operation") if isinstance(request, dict) else None,
        "phase": PHASE,
        "message": str(error),
        "mutated": MUTATED,
        "exchanged": EXCHANGED,
        "rolledBack": rolled_back,
        "rollbackError": rollback_error,
    }, sort_keys=True, separators=(",", ":")))
finally:
    for descriptor in (TARGET_FD, RECOVERY_FD, ROOT_FD, GIT_FD):
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
`;

const configError = (message: string, cause?: unknown) =>
  new CommandCenterError({
    reason: "config",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const conflictError = (message: string, cause?: unknown) =>
  new CommandCenterError({
    reason: "conflict",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const persistenceError = (message: string, cause?: unknown) =>
  new CommandCenterError({
    reason: "persistence",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

export interface AtomicFileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly sha256: string;
}

export interface AtomicDirectoryIdentity {
  readonly dev: string;
  readonly ino: string;
}

export interface AtomicExchangeTestControl {
  readonly readyPath?: string;
  readonly continuePath?: string;
  readonly pauseAt?:
    | "before_mutation"
    | "after_recovery_root_open"
    | "before_preserve_last_check"
    | "after_preserve_last_check"
    | "after_preserve_move"
    | "before_compensating_move"
    | "after_compensating_move_last_check"
    | "after_target_last_check"
    | "after_target_mutation"
    | "before_compensating_target"
    | "after_compensating_target_last_check"
    | "before_index_exchange"
    | "after_index_last_check"
    | "after_index_exchange"
    | "before_compensating_index"
    | "after_compensating_index_last_check"
    | "after_compensating_lock_last_check";
  readonly failTerminalAt?: "before_link" | "after_link" | "after_fsync";
  readonly failAfterTargetMutation?: boolean;
  readonly failAfterPreserveMove?: boolean;
  readonly failAfterIndexExchange?: boolean;
  readonly crashAt?: "after_target_mutation" | "after_index_exchange" | "after_complete_manifest";
}

export interface AtomicPreserveCreatedInput {
  readonly manifestId: string;
  readonly sourceDirectory: string;
  readonly sourceName: string;
  readonly recoveryDirectory: string;
  readonly recoveryName: string;
  readonly expectedSourceDirectory: AtomicDirectoryIdentity;
  readonly expectedRecoveryDirectory: AtomicDirectoryIdentity;
  readonly expectedSource: AtomicFileIdentity;
}

export interface AtomicPrepareRecoveryInput {
  readonly gitDirectory: string;
  readonly expectedGitDirectory: AtomicDirectoryIdentity;
  readonly rootName: string;
  readonly transactionPrefix: string;
}

export interface AtomicPrepareRecoveryResult {
  readonly recoveryRoot: string;
  readonly recoveryRootIdentity: AtomicDirectoryIdentity;
  readonly recoveryDirectory: string;
  readonly recoveryDirectoryIdentity: AtomicDirectoryIdentity;
}

export interface AtomicPublishContentsInput {
  readonly mode: "create" | "update";
  readonly manifestId: string;
  readonly targetDirectory: string;
  readonly targetName: string;
  readonly recoveryDirectory: string;
  readonly recoveryName: string;
  readonly expectedTargetDirectory: AtomicDirectoryIdentity;
  readonly expectedRecoveryDirectory: AtomicDirectoryIdentity;
  readonly expectedTarget?: AtomicFileIdentity;
  readonly contents: Uint8Array;
}

export interface AtomicPublishContentsResult {
  readonly mode: "create" | "update";
  readonly target: AtomicFileIdentity;
  readonly recovery?: AtomicFileIdentity;
}

export interface AtomicPublishIndexInput {
  readonly manifestId: string;
  readonly gitDirectory: string;
  readonly recoveryDirectory: string;
  readonly indexName: string;
  readonly lockName: string;
  readonly expectedGitDirectory: AtomicDirectoryIdentity;
  readonly expectedRecoveryDirectory: AtomicDirectoryIdentity;
  readonly expectedIndex: AtomicFileIdentity;
  readonly contents: Uint8Array;
}

export interface AtomicPublishIndexResult {
  readonly index: AtomicFileIdentity;
  readonly previousIndex: AtomicFileIdentity;
}

export interface AtomicTargetExchangeOptions {
  readonly platform?: NodeJS.Platform;
  readonly pythonEntrypoint?: string;
  /** Internal deterministic integration-test seam; production leaves this absent. */
  readonly testControl?: AtomicExchangeTestControl;
}

const AtomicFileIdentitySchema = Schema.Struct({
  dev: Schema.String,
  ino: Schema.String,
  size: Schema.String,
  sha256: Schema.String,
});

const AtomicDirectoryIdentitySchema = Schema.Struct({
  dev: Schema.String,
  ino: Schema.String,
});

const AuthoringHelperResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  operation: Schema.optional(Schema.String),
  phase: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
  rolledBack: Schema.optional(Schema.Boolean),
  rollbackError: Schema.optional(Schema.NullOr(Schema.String)),
  target: Schema.optional(AtomicFileIdentitySchema),
  recovery: Schema.optional(Schema.NullOr(AtomicFileIdentitySchema)),
  index: Schema.optional(AtomicFileIdentitySchema),
  previousIndex: Schema.optional(AtomicFileIdentitySchema),
  recoveryRoot: Schema.optional(Schema.String),
  recoveryRootIdentity: Schema.optional(AtomicDirectoryIdentitySchema),
  recoveryDirectory: Schema.optional(Schema.String),
  recoveryDirectoryIdentity: Schema.optional(AtomicDirectoryIdentitySchema),
});

const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const decodeJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const decodeAuthoringHelperResult = Schema.decodeUnknownEffect(AuthoringHelperResultSchema);

function sha256(contents: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(contents).digest("hex");
}

function safeEntryName(name: string): boolean {
  return (
    name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\")
  );
}

function safeManifestId(name: string): boolean {
  return safeEntryName(name) && Buffer.byteLength(name, "utf8") <= 64;
}

export const makeAtomicTargetExchange = (options: AtomicTargetExchangeOptions = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner;
    const hostPlatform = yield* HostProcessPlatform;

    const captureFile = Effect.fn("AtomicTargetExchange.captureFile")(function* (filePath: string) {
      const realPath = yield* fs
        .realPath(filePath)
        .pipe(
          Effect.mapError((cause) =>
            conflictError("Could not resolve an atomic exchange file.", cause),
          ),
        );
      if (path.resolve(realPath) !== path.resolve(filePath)) {
        return yield* conflictError("Symbolic-link atomic exchange files are not allowed.");
      }
      const before = yield* fs
        .stat(filePath)
        .pipe(
          Effect.mapError((cause) =>
            conflictError("Could not inspect an atomic exchange file.", cause),
          ),
        );
      const contents = yield* fs
        .readFile(filePath)
        .pipe(
          Effect.mapError((cause) =>
            conflictError("Could not hash an atomic exchange file.", cause),
          ),
        );
      const after = yield* fs
        .stat(filePath)
        .pipe(
          Effect.mapError((cause) =>
            conflictError("Could not re-inspect an atomic exchange file.", cause),
          ),
        );
      const beforeIno = Option.getOrUndefined(before.ino);
      const afterIno = Option.getOrUndefined(after.ino);
      if (
        before.type !== "File" ||
        after.type !== "File" ||
        beforeIno === undefined ||
        afterIno === undefined ||
        before.dev !== after.dev ||
        beforeIno !== afterIno ||
        before.size !== after.size ||
        BigInt(contents.byteLength) !== after.size
      ) {
        return yield* conflictError("An atomic exchange file changed while it was inspected.");
      }
      return {
        dev: String(after.dev),
        ino: String(afterIno),
        size: String(after.size),
        sha256: sha256(contents),
      } satisfies AtomicFileIdentity;
    });

    const captureDirectory = Effect.fn("AtomicTargetExchange.captureDirectory")(function* (
      directory: string,
    ) {
      const realDirectory = yield* fs
        .realPath(directory)
        .pipe(
          Effect.mapError((cause) =>
            conflictError("Could not resolve an atomic exchange directory.", cause),
          ),
        );
      if (path.resolve(realDirectory) !== path.resolve(directory)) {
        return yield* conflictError("Symbolic-link atomic exchange directories are not allowed.");
      }
      const info = yield* fs
        .stat(directory)
        .pipe(
          Effect.mapError((cause) =>
            conflictError("Could not inspect an atomic exchange directory.", cause),
          ),
        );
      const ino = Option.getOrUndefined(info.ino);
      if (info.type !== "Directory" || ino === undefined) {
        return yield* conflictError("Atomic exchange storage is not a real directory.");
      }
      return { dev: String(info.dev), ino: String(ino) } satisfies AtomicDirectoryIdentity;
    });

    const resolveTrustedPython = Effect.fn("AtomicTargetExchange.resolveTrustedPython")(
      function* () {
        if ((options.platform ?? hostPlatform) !== "linux") {
          return yield* configError(
            "Atomic automation authoring is unavailable on this platform; Linux renameat2 support is required.",
          );
        }
        const executable = yield* fs
          .realPath(options.pythonEntrypoint ?? PYTHON_ENTRYPOINT)
          .pipe(
            Effect.mapError((cause) =>
              configError("The trusted atomic exchange helper is unavailable.", cause),
            ),
          );
        if (!SAFE_PYTHON_PATH.test(executable)) {
          return yield* configError("The atomic exchange helper resolved outside /usr/bin.");
        }
        const info = yield* fs
          .stat(executable)
          .pipe(
            Effect.mapError((cause) =>
              configError("The atomic exchange helper could not be inspected.", cause),
            ),
          );
        const systemDirectories = yield* Effect.forEach(["/", "/usr", "/usr/bin"], (directory) =>
          fs
            .stat(directory)
            .pipe(
              Effect.mapError((cause) =>
                configError("The atomic exchange helper trust path could not be inspected.", cause),
              ),
            ),
        );
        const executableUid = Option.getOrUndefined(info.uid);
        const currentUid = process.getuid?.();
        const overflowUid = yield* fs.readFileString("/proc/sys/kernel/overflowuid").pipe(
          Effect.map((value) => Number.parseInt(value.trim(), 10)),
          Effect.orElseSucceed(() => Number.NaN),
        );
        const uidMap = yield* fs
          .readFileString("/proc/self/uid_map")
          .pipe(Effect.orElseSucceed(() => ""));
        const namespaceMapsCurrentToRoot = uidMap
          .trim()
          .split("\n")
          .some((line) => {
            const [inside, outside, length] = line.trim().split(/\s+/u).map(Number);
            return inside === currentUid && outside === 0 && length !== undefined && length > 0;
          });
        const namespaceRootOwned =
          executableUid !== undefined &&
          executableUid === overflowUid &&
          executableUid !== currentUid &&
          namespaceMapsCurrentToRoot;
        const trustedSystemOwner = executableUid === 0 || namespaceRootOwned;
        if (
          info.type !== "File" ||
          executableUid === undefined ||
          !trustedSystemOwner ||
          (info.mode & 0o022) !== 0 ||
          systemDirectories.some(
            (directory) =>
              directory.type !== "Directory" ||
              Option.getOrUndefined(directory.uid) !== executableUid ||
              (directory.mode & 0o022) !== 0,
          )
        ) {
          return yield* configError(
            "The atomic exchange helper and its system path must be root-owned (or namespace-root-owned) and not group- or world-writable.",
          );
        }
        return executable;
      },
    );

    const runAuthoringTransaction = Effect.fn("AtomicTargetExchange.runAuthoringTransaction")(
      function* (request: Readonly<Record<string, unknown>>) {
        const executable = yield* resolveTrustedPython();
        const result = yield* runner
          .run({
            command: executable,
            args: ["-I", "-S", "-c", PYTHON_AUTHORING_TRANSACTION],
            env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
            extendEnv: false,
            stdin: encodeJson({
              ...request,
              ...(options.testControl === undefined ? {} : { testControl: options.testControl }),
            }),
            timeout: "20 seconds",
            maxOutputBytes: 64 * 1024,
          })
          .pipe(
            Effect.uninterruptible,
            Effect.mapError((cause) =>
              persistenceError(
                "The atomic automation authoring helper failed; inspect its durable recovery transaction before retrying.",
                cause,
              ),
            ),
          );
        if (result.code !== 0) {
          return yield* persistenceError(
            `The atomic automation authoring helper exited before reporting a safe result (code ${String(result.code)}).`,
          );
        }
        const decoded = yield* decodeJson(result.stdout).pipe(
          Effect.mapError((cause) =>
            persistenceError(
              "The atomic automation authoring helper returned invalid JSON.",
              cause,
            ),
          ),
        );
        return yield* decodeAuthoringHelperResult(decoded).pipe(
          Effect.mapError((cause) =>
            persistenceError(
              "The atomic automation authoring helper returned an invalid result.",
              cause,
            ),
          ),
        );
      },
    );

    const prepareRecoveryDirectory = Effect.fn("AtomicTargetExchange.prepareRecoveryDirectory")(
      (input: AtomicPrepareRecoveryInput) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (
              !path.isAbsolute(input.gitDirectory) ||
              !safeEntryName(input.rootName) ||
              !safeEntryName(input.transactionPrefix)
            ) {
              return yield* configError(
                "Automation recovery paths and names must be absolute and safe.",
              );
            }
            const parsed = yield* runAuthoringTransaction({
              operation: "prepare-recovery",
              ...input,
            });
            if (
              !parsed.ok ||
              parsed.operation !== "prepare-recovery" ||
              parsed.recoveryRoot === undefined ||
              parsed.recoveryRootIdentity === undefined ||
              parsed.recoveryDirectory === undefined ||
              parsed.recoveryDirectoryIdentity === undefined
            ) {
              return yield* conflictError(
                `Automation recovery allocation stopped at ${parsed.phase ?? "unknown"}: ${parsed.message ?? "identity verification failed"}.`,
                parsed,
              );
            }
            return {
              recoveryRoot: parsed.recoveryRoot,
              recoveryRootIdentity: parsed.recoveryRootIdentity,
              recoveryDirectory: parsed.recoveryDirectory,
              recoveryDirectoryIdentity: parsed.recoveryDirectoryIdentity,
            } satisfies AtomicPrepareRecoveryResult;
          }),
        ),
    );

    const publishContents = Effect.fn("AtomicTargetExchange.publishContents")(
      (input: AtomicPublishContentsInput) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (
              !path.isAbsolute(input.targetDirectory) ||
              !path.isAbsolute(input.recoveryDirectory) ||
              !safeManifestId(input.manifestId) ||
              !safeEntryName(input.targetName) ||
              !safeEntryName(input.recoveryName) ||
              (input.mode === "update" && input.expectedTarget === undefined) ||
              (input.mode === "create" && input.expectedTarget !== undefined)
            ) {
              return yield* configError(
                "Automation publication paths, names, and expected identities are invalid.",
              );
            }
            const contents = Buffer.from(input.contents);
            const parsed = yield* runAuthoringTransaction({
              operation: "publish-contents",
              mode: input.mode,
              manifestId: input.manifestId,
              targetDirectory: input.targetDirectory,
              targetName: input.targetName,
              recoveryDirectory: input.recoveryDirectory,
              recoveryName: input.recoveryName,
              expectedTargetDirectory: input.expectedTargetDirectory,
              expectedRecoveryDirectory: input.expectedRecoveryDirectory,
              ...(input.expectedTarget === undefined
                ? {}
                : { expectedTarget: input.expectedTarget }),
              contentsBase64: contents.toString("base64"),
              expectedContentsSize: String(contents.byteLength),
              expectedContentsSha256: sha256(contents),
            });
            if (
              !parsed.ok ||
              parsed.operation !== "publish-contents" ||
              parsed.mode !== input.mode ||
              parsed.target === undefined ||
              (input.mode === "update" && parsed.recovery == null) ||
              (input.mode === "create" && parsed.recovery !== null)
            ) {
              return yield* conflictError(
                `Automation target publication stopped at ${parsed.phase ?? "unknown"}: ${parsed.message ?? "identity verification failed"}.`,
                parsed,
              );
            }
            return {
              mode: input.mode,
              target: parsed.target,
              ...(parsed.recovery == null ? {} : { recovery: parsed.recovery }),
            } satisfies AtomicPublishContentsResult;
          }),
        ),
    );

    const publishIndex = Effect.fn("AtomicTargetExchange.publishIndex")(
      (input: AtomicPublishIndexInput) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (
              !path.isAbsolute(input.gitDirectory) ||
              !path.isAbsolute(input.recoveryDirectory) ||
              !safeManifestId(input.manifestId) ||
              !safeEntryName(input.indexName) ||
              !safeEntryName(input.lockName)
            ) {
              return yield* configError(
                "Index publication paths and names must be absolute and safe.",
              );
            }
            const contents = Buffer.from(input.contents);
            const parsed = yield* runAuthoringTransaction({
              operation: "publish-index",
              manifestId: input.manifestId,
              gitDirectory: input.gitDirectory,
              recoveryDirectory: input.recoveryDirectory,
              indexName: input.indexName,
              lockName: input.lockName,
              expectedGitDirectory: input.expectedGitDirectory,
              expectedRecoveryDirectory: input.expectedRecoveryDirectory,
              expectedIndex: input.expectedIndex,
              contentsBase64: contents.toString("base64"),
              expectedContentsSize: String(contents.byteLength),
              expectedContentsSha256: sha256(contents),
            });
            if (
              !parsed.ok ||
              parsed.operation !== "publish-index" ||
              parsed.index === undefined ||
              parsed.previousIndex === undefined
            ) {
              return yield* conflictError(
                `Private index publication stopped at ${parsed.phase ?? "unknown"}: ${parsed.message ?? "identity verification failed"}.`,
                parsed,
              );
            }
            return {
              index: parsed.index,
              previousIndex: parsed.previousIndex,
            } satisfies AtomicPublishIndexResult;
          }),
        ),
    );

    const preflight = Effect.fn("AtomicTargetExchange.preflight")(function* () {
      const executable = yield* resolveTrustedPython();
      const result = yield* runner
        .run({
          command: executable,
          args: ["-I", "-S", "-c", PYTHON_PREFLIGHT],
          env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
          extendEnv: false,
          timeout: "5 seconds",
          maxOutputBytes: 4 * 1024,
        })
        .pipe(
          Effect.mapError((cause) =>
            configError("The atomic automation authoring preflight could not run.", cause),
          ),
        );
      if (result.code !== 0 || result.stdout !== "renameat2-ready\n") {
        return yield* configError(
          "Atomic automation authoring requires libc and kernel renameat2 support.",
        );
      }
    });

    const syncDirectory = Effect.fn("AtomicTargetExchange.syncDirectory")(function* (
      directory: string,
      expected: AtomicDirectoryIdentity,
    ) {
      if (!path.isAbsolute(directory)) {
        return yield* configError("Directory durability targets must be absolute paths.");
      }
      const executable = yield* resolveTrustedPython();
      const result = yield* runner
        .run({
          command: executable,
          args: ["-I", "-S", "-c", PYTHON_DIRECTORY_FSYNC],
          env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
          extendEnv: false,
          stdin: encodeJson({ directory, expected }),
          timeout: "5 seconds",
          maxOutputBytes: 4 * 1024,
        })
        .pipe(
          Effect.mapError((cause) =>
            persistenceError("The durable directory sync helper could not run.", cause),
          ),
        );
      if (result.code !== 0 || result.stdout !== "fsync-directory-ready\n") {
        return yield* conflictError(
          "A durable directory sync could not verify its pinned filesystem target.",
          result,
        );
      }
    });

    const preserveCreated = Effect.fn("AtomicTargetExchange.preserveCreated")(function* (
      input: AtomicPreserveCreatedInput,
    ) {
      if (
        !safeManifestId(input.manifestId) ||
        !safeEntryName(input.sourceName) ||
        !safeEntryName(input.recoveryName) ||
        !path.isAbsolute(input.sourceDirectory) ||
        !path.isAbsolute(input.recoveryDirectory)
      ) {
        return yield* configError(
          "Created-file preservation paths and names must be absolute and safe.",
        );
      }
      const parsed = yield* runAuthoringTransaction({
        operation: "preserve-created",
        ...input,
      });
      if (!parsed.ok || parsed.operation !== "preserve-created" || parsed.recovery == null) {
        return yield* conflictError(
          `Created automation preservation stopped at ${parsed.phase ?? "unknown"}: ${parsed.message ?? "identity verification failed"}.`,
          parsed,
        );
      }
      return parsed.recovery;
    });

    return {
      captureFile,
      captureDirectory,
      preflight,
      prepareRecoveryDirectory,
      publishContents,
      publishIndex,
      preserveCreated,
      syncDirectory,
    } as const;
  });
