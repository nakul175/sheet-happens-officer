// CONTAINMENT (slot 9) — the host stand-ins the offline sandboxes share.
//
// Three test files run the REAL scripts/containment/slot9-proof.sh against a temp-dir sandbox: proof-gates,
// unit-env-sources and proof-verdict-terms. Each used to write its own `systemctl`/`pgrep` stub, which meant
// the same host question was modelled three ways — and a stub that answers nothing makes an unasserted
// property (User=, InaccessiblePaths=) look like a satisfied one. One copy here, so a stub cannot quietly
// answer less than the others.
//
// Nothing in this module touches a host: it returns SHELL TEXT that the caller writes into the sandbox's bin/.
// No sudo, no systemd, no ssh, no /etc, no secret.

// The properties slot9-proof.sh asserts as verdict terms. Kept here (rather than only in the test) so the
// stub answers exactly the set the script asks about instead of a hand-maintained second list.
export const SANDBOX_PROPERTIES = [
  "User",
  "NoNewPrivileges",
  "ProtectSystem",
  "ProtectHome",
  "PrivateTmp",
  "InaccessiblePaths",
  "RestrictNamespaces",
];

// The [Service] block render_unit() (slot9-optionR.sh) writes, as a sandbox caller would write it. `shoDir`
// is the caller's stand-in for /etc/sho, because every sandbox rewrites that path into its temp dir.
export function containmentLines({ shoDir, user = "shoslot" } = {}) {
  return [
    `User=${user}`,
    "NoNewPrivileges=yes",
    "ProtectSystem=strict",
    "ProtectHome=read-only",
    "PrivateTmp=yes",
    `InaccessiblePaths=${shoDir}`,
    "RestrictNamespaces=yes",
  ];
}

// `systemctl show`: answers each requested -p from the unit file, the way the manager does for a rendered
// unit that has never been started. This is what makes `--pre-start` answerable without a MainPID, and what
// makes a sandbox unit with `User=root` say so out loud instead of stubbing the question away.
export function systemctlBody({ unitFile, mainPid = "" }) {
  return [
    "args=\" $* \"",
    `unit='${unitFile}'`,
    'case "$args" in',
    "  *\" -p MainPID \"*)",
    '    case "$args" in *"--value"*) printf \'%s\\n\' "' + mainPid + '" ;; *) echo "MainPID=' + mainPid + '" ;; esac',
    "    exit 0 ;;",
    "esac",
    'value=0; case "$args" in *"--value"*) value=1 ;; esac',
    `for p in ${SANDBOX_PROPERTIES.join(" ")}; do`,
    '  case "$args" in *" -p $p "*) ;; *) continue ;; esac',
    '  v=$(sed -n "s/^$p=//p" "$unit" 2>/dev/null | head -n1)',
    '  if [ "$value" = 1 ]; then printf \'%s\\n\' "$v"; else printf \'%s=%s\\n\' "$p" "$v"; fi',
    "done",
    "exit 0",
  ].join("\n");
}

// `pgrep -u deploy -n`: a deploy-owned process exists. The proof measures shoslot's read of its
// /proc/<pid>/environ, so "there is no deploy process" is not a denial — it is an unrun probe.
export function pgrepBody(deployPid) {
  return `[ -n "${deployPid}" ] && printf '%s\\n' "${deployPid}"\nexit 0`;
}
