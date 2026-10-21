# Sourced by mac-keychain-ssh.sh. Runs `security <args>` and answers its tty password prompt
# from $KEYCHAIN_PASSWORD, so the password never appears on argv (visible in ps).
# Returns security's own exit status; fails on a second prompt (wrong password) or a timeout.
security_with_password() {
  expect -f - "$@" <<'EOF'
set timeout 30
spawn /usr/bin/security {*}$argv
set answered 0
expect {
  -re {(?i)password[^\r\n]*:\s*$} {
    if {$answered} { exit 1 }
    set answered 1
    send -- "$env(KEYCHAIN_PASSWORD)\r"
    exp_continue
  }
  timeout { exit 1 }
  eof
}
lassign [wait] pid spawn_id os_error status
exit $status
EOF
}
