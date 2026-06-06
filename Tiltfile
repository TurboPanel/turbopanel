load("tilt/deno.tiltfile", "run_deno_mode")
load("tilt/workers.tiltfile", "run_workers_mode")

# -----------------------------------------------------------------------------
# Config: positional args (e.g. "workers" for Workers mode) and optional flags
# -----------------------------------------------------------------------------
config.define_string_list("_tiltfile_args", args = True)
cfg = config.parse()
tiltfile_args = cfg.get("_tiltfile_args", [])

# -----------------------------------------------------------------------------
# Positional args: workers | (default) deno
# -----------------------------------------------------------------------------
if tiltfile_args == ["workers"]:
    run_workers_mode()
else:
    run_deno_mode()
