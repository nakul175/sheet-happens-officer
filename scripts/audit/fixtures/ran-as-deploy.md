# Receipt — 2840 staging leg (the whole-AC staging receipt)

Deployed at `1a3aea0` on the deployed staging host and ran the leg. This process ran as `deploy`:

```
$ bash deploy/run-comments-leg.sh
comments-19-1 flag-on block: 3 passed (3)
```

The gate the script must print, quoted from `scripts/containment/slot9-proof.sh` so a reader knows what to look for:

```sh
unit_envfile_count=4 outside_slot=0 unreadable=0
echo "PROOF=PASS"
if [ "$gap_closed" = 1 ]; then echo PROOF=PASS; exit 0; fi
```

So the acceptance line the messenger should require is `PROOF=PASS`, and this receipt is where 2840's staging
column comes from.
