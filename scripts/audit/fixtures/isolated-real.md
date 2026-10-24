# Receipt — slot 9 proof, one run as the slot account

host=sho-staging.internal
unit=sho-pr9@9.service
identity=shoslot (uid 991, not deploy)

`slot9-proof.sh` exited 0 and printed, verbatim:

```
slot9-proof: P1..P5
slot9-proof: unit_envfile_count=4 outside_slot=0 unreadable=0 prod_markers=0 env_guard=4
slot9-proof: uids_differ=1 shoslot_can_read_prod_env=1 gap_closed=1
PROOF=PASS
```

No production unit was touched; `systemctl restart sho` was not run.
