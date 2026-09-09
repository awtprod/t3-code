// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  attachmentFileExtension,
  createAttachmentId,
  createPendingAttachmentId,
  parseAttachmentUuid,
  parseAttachmentFileExtension,
  planAttachmentClaim,
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  resolveAttachmentPathById,
  sweepStalePendingAttachments,
} from "./attachmentStore.ts";

describe("attachmentStore", () => {
  it("sanitizes thread ids when creating attachment ids", () => {
    const attachmentId = createAttachmentId("thread.folder/unsafe space");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }

    const threadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    expect(threadSegment).toBeTruthy();
    expect(threadSegment).toMatch(/^[a-z0-9_-]+$/i);
    expect(threadSegment).not.toContain(".");
    expect(threadSegment).not.toContain("%");
    expect(threadSegment).not.toContain("/");
  });

  it("parses exact thread segments from attachment ids without prefix collisions", () => {
    const fooId = "foo-00000000-0000-4000-8000-000000000001";
    const fooBarId = "foo-bar-00000000-0000-4000-8000-000000000002";

    expect(parseThreadSegmentFromAttachmentId(fooId)).toBe("foo");
    expect(parseThreadSegmentFromAttachmentId(fooBarId)).toBe("foo-bar");
  });

  it("normalizes created thread segments to lowercase", () => {
    const attachmentId = createAttachmentId("Thread.Foo");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }
    expect(parseThreadSegmentFromAttachmentId(attachmentId)).toBe("thread-foo");
  });

  it("reserves the pending attachment segment", () => {
    const pendingId = createPendingAttachmentId();
    expect(parseThreadSegmentFromAttachmentId(pendingId)).toBe(PENDING_ATTACHMENT_THREAD_SEGMENT);
    expect(parseAttachmentUuid(pendingId)).toMatch(/^[a-f0-9-]{36}$/);
    for (const threadId of ["pending", "_pending", "__pending"]) {
      const finalId = createAttachmentId(threadId)!;
      expect(parseThreadSegmentFromAttachmentId(finalId)).toBe("pending");
      expect(parseThreadSegmentFromAttachmentId(finalId)).not.toBe(
        PENDING_ATTACHMENT_THREAD_SEGMENT,
      );
    }
    expect(parseThreadSegmentFromAttachmentId(createAttachmentId("pending_thread")!)).toBe(
      "pending_thread",
    );
  });

  it("preserves safe file extensions in attachment ids and paths", () => {
    const attachmentId = createPendingAttachmentId(".PDF");

    expect(parseThreadSegmentFromAttachmentId(attachmentId)).toBe(
      PENDING_ATTACHMENT_THREAD_SEGMENT,
    );
    expect(parseAttachmentUuid(attachmentId)).toMatch(/^[a-f0-9-]{36}$/);
    expect(parseAttachmentFileExtension(attachmentId)).toBe("pdf");
    expect(attachmentFileExtension("report.PDF")).toBe(".pdf");
    expect(attachmentFileExtension("report")).toBe(".bin");
    expect(attachmentFileExtension("report.extensiontoolong")).toBe(".bin");
    // ".part" is the in-flight upload suffix; storing it would make the file
    // look like a stale partial to the sweep.
    expect(attachmentFileExtension("archive.part")).toBe(".bin");
    expect(createAttachmentId("x".repeat(80), ".abcdefghij")?.length).toBeLessThanOrEqual(128);
  });

  it("resolves attachment path by id using the extension that exists on disk", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const attachmentId = "thread-1-attachment";
      const pngPath = NodePath.join(attachmentsDir, `${attachmentId}.png`);
      NodeFS.writeFileSync(pngPath, Buffer.from("hello"));

      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId,
      });
      expect(resolved).toBe(pngPath);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("returns null when no attachment file exists for the id", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId: "thread-1-missing",
      });
      expect(resolved).toBeNull();
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("resolves generic attachments without scanning the attachment directory", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-file-attachment-"),
    );
    try {
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000001-zip";
      const archivePath = NodePath.join(attachmentsDir, `${attachmentId}.zip`);
      NodeFS.writeFileSync(archivePath, Buffer.from("archive"));

      expect(resolveAttachmentPathById({ attachmentsDir, attachmentId })).toBe(archivePath);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("plans pending attachment claims with direct filename lookups", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-claim-"),
    );
    try {
      const uuid = "00000000-0000-4000-8000-000000000001";
      const pendingId = `${PENDING_ATTACHMENT_THREAD_SEGMENT}-${uuid}`;
      const pendingPath = NodePath.join(attachmentsDir, `${pendingId}.png`);
      NodeFS.writeFileSync(pendingPath, Buffer.from("pixels"));

      const claim = planAttachmentClaim({
        attachmentsDir,
        threadId: "thread-1",
        attachmentId: pendingId,
      });
      expect(claim).toMatchObject({
        ok: true,
        currentPath: pendingPath,
      });
      if (!claim.ok) {
        return;
      }
      expect(parseThreadSegmentFromAttachmentId(claim.finalId)).toBe("thread-1");
      expect(parseAttachmentUuid(claim.finalId)).not.toBe(uuid);
      expect(claim.finalPath).toBe(NodePath.join(attachmentsDir, `${claim.finalId}.png`));
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("rejects thread-owned attachments even when thread segments collide", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-ownership-"),
    );
    try {
      const attachmentId = "a-b-00000000-0000-4000-8000-000000000003";
      NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${attachmentId}.png`), "pixels");

      expect(planAttachmentClaim({ attachmentsDir, threadId: "a b", attachmentId })).toEqual({
        ok: false,
        reason: "attachment must be a pending upload",
      });
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("removes expired pending and partial files without touching thread attachments", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-sweep-"),
    );
    try {
      const now = 1_800_000_000_000;
      const oldTimeSeconds = (now - 2 * 24 * 60 * 60 * 1000) / 1000;
      const uuid = "00000000-0000-4000-8000-000000000002";
      const pendingPath = NodePath.join(
        attachmentsDir,
        `${PENDING_ATTACHMENT_THREAD_SEGMENT}-${uuid}.png`,
      );
      const pendingFilePath = NodePath.join(
        attachmentsDir,
        `${PENDING_ATTACHMENT_THREAD_SEGMENT}-${uuid}-pdf.pdf`,
      );
      const legacyPendingPath = NodePath.join(attachmentsDir, `pending-${uuid}.png`);
      const legacyRemappedPath = NodePath.join(attachmentsDir, `_pending-${uuid}.png`);
      const threadPath = NodePath.join(attachmentsDir, `thread-1-${uuid}.png`);
      const partialPath = NodePath.join(attachmentsDir, `${uuid}.part`);
      for (const filePath of [
        pendingPath,
        pendingFilePath,
        legacyPendingPath,
        legacyRemappedPath,
        threadPath,
        partialPath,
      ]) {
        NodeFS.writeFileSync(filePath, Buffer.from("pixels"));
        NodeFS.utimesSync(filePath, oldTimeSeconds, oldTimeSeconds);
      }

      expect(sweepStalePendingAttachments({ attachmentsDir, nowMs: now })).toEqual({ deleted: 3 });
      expect(NodeFS.existsSync(pendingPath)).toBe(false);
      expect(NodeFS.existsSync(pendingFilePath)).toBe(false);
      expect(NodeFS.existsSync(partialPath)).toBe(false);
      expect(NodeFS.existsSync(legacyPendingPath)).toBe(true);
      expect(NodeFS.existsSync(legacyRemappedPath)).toBe(true);
      expect(NodeFS.existsSync(threadPath)).toBe(true);
      expect(resolveAttachmentPathById({ attachmentsDir, attachmentId: `pending-${uuid}` })).toBe(
        legacyPendingPath,
      );
      expect(
        resolveAttachmentPathById({
          attachmentsDir,
          attachmentId: `_pending-${uuid}`,
        }),
      ).toBe(legacyRemappedPath);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });
});
