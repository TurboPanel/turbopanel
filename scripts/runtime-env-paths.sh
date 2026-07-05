# Resolve secret-bearing runtime env paths from the instance-launch contract.
# Prefer injected vars; compose from TURBOPANEL_CONFIG_DIR when only that is set.
runtime_env_config_dir() {
  printf '%s' "${TURBOPANEL_CONFIG_DIR:-/etc/turbopanel}"
  return 0
}

runtime_env_path() {
  if [[ -n "${TURBOPANEL_INSTANCE_RUNTIME_ENV:-}" ]]; then
    printf '%s' "$TURBOPANEL_INSTANCE_RUNTIME_ENV"
    return 0
  fi
  printf '%s/instance/runtime.env' "$(runtime_env_config_dir)"
  return 0
}

runtime_dev_vars_path() {
  if [[ -n "${TURBOPANEL_INSTANCE_RUNTIME_DEV_VARS:-}" ]]; then
    printf '%s' "$TURBOPANEL_INSTANCE_RUNTIME_DEV_VARS"
    return 0
  fi
  printf '%s/instance/runtime.dev-vars' "$(runtime_env_config_dir)"
}
