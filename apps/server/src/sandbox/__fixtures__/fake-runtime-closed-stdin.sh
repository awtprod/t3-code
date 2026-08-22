#!/bin/sh
# Stands in for `podman exec`: ignores the exec flags it is handed, closes its
# own stdin, and stays alive -- the shape a container takes when the process
# inside it has stopped reading but the container has not exited yet.
exec 0<&-
sleep 2
