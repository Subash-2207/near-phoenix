# PHOENIX

Phase 3 monitoring and recovery are implemented in ../recovery. Its cancellable
poller consumes signed worker liveness, detects chain heartbeat expiry, reports a
crash, selects an owner-registered ready backup and restores only after independent
sentinel authorization and a confirmed new epoch. The process demonstration kills
a real primary worker. See ../../docs/phase3-validation.md for results and limits.
