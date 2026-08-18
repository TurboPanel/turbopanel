import {
  parseDefaultEnvironmentNameInput,
  parseMaxServersInput,
} from "../../lib/organization-options.ts";
import { DISPLAY_NAME_MAX_LENGTH } from "../../lib/display-name-format.ts";
import { isAllowedTimezone } from "../../lib/timezones.ts";
import type { OrganizationSummary } from "../org-context.ts";
import { BadRequestError, parseDisplayName } from "../shared.ts";
import {
  parseDefaultFabricEnabledInput,
  parseNtpDefaultsInput,
  parseSshPortInput,
  type NtpDefaults,
} from "../../lib/host-defaults.ts";

/** Matches {@link NEW_ORGANIZATION_NAME} in authn/install-state.ts. */
const NEW_ORGANIZATION_DISPLAY_NAME = "New Organization";

export type OrganizationRouteValidationError = {
  ok: false;
  error: string;
  status: 400;
};

export type DefaultTimezonePatch = {
  defaultServerTimezone?: string | null;
  enforceServerTimezone?: boolean;
};

export type HostDefaultsPatch = {
  sshPort?: number | null;
  ntp?: NtpDefaults | null;
  defaultFabricEnabled?: boolean | null;
};

export function parseDefaultTimezonePatch(
  body: Record<string, unknown>,
):
  | { ok: true; patch: DefaultTimezonePatch }
  | OrganizationRouteValidationError {
  const patch: DefaultTimezonePatch = {};

  if ("defaultServerTimezone" in body) {
    if (body.defaultServerTimezone === null) {
      patch.defaultServerTimezone = null;
    } else if (
      typeof body.defaultServerTimezone === "string" &&
      isAllowedTimezone(body.defaultServerTimezone)
    ) {
      patch.defaultServerTimezone = body.defaultServerTimezone;
    } else {
      return { ok: false, error: "Invalid defaultServerTimezone", status: 400 };
    }
  }

  if ("enforceServerTimezone" in body) {
    if (typeof body.enforceServerTimezone !== "boolean") {
      return { ok: false, error: "Invalid enforceServerTimezone", status: 400 };
    }
    patch.enforceServerTimezone = body.enforceServerTimezone;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "Invalid request", status: 400 };
  }

  return { ok: true, patch };
}

export function parseHostDefaultsPatch(
  body: Record<string, unknown>,
):
  | { ok: true; patch: HostDefaultsPatch }
  | OrganizationRouteValidationError {
  const patch: HostDefaultsPatch = {};

  if ("sshPort" in body) {
    const parsed = parseSshPortInput(body.sshPort);
    if (!parsed.ok) {
      return { ok: false, error: "Invalid sshPort", status: 400 };
    }
    patch.sshPort = parsed.value;
  }

  if ("ntp" in body) {
    const parsed = parseNtpDefaultsInput(body.ntp);
    if (!parsed.ok) {
      return { ok: false, error: "Invalid ntp", status: 400 };
    }
    patch.ntp = parsed.value;
  }

  if ("defaultFabricEnabled" in body) {
    const parsed = parseDefaultFabricEnabledInput(body.defaultFabricEnabled);
    if (!parsed.ok) {
      return { ok: false, error: "Invalid defaultFabricEnabled", status: 400 };
    }
    patch.defaultFabricEnabled = parsed.value;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "Invalid request", status: 400 };
  }

  return { ok: true, patch };
}

export function parseDefaultEnvironmentPutBody(
  body: Record<string, unknown>,
):
  | { ok: true; defaultEnvironmentName: string | null }
  | OrganizationRouteValidationError {
  if (!("defaultEnvironmentName" in body)) {
    return { ok: false, error: "Invalid request", status: 400 };
  }

  const parsed = parseDefaultEnvironmentNameInput(body.defaultEnvironmentName);
  if (!parsed.ok) {
    return {
      ok: false,
      error:
        `defaultEnvironmentName must be null or a non-empty name of at most ${String(DISPLAY_NAME_MAX_LENGTH)} characters with no control characters`,
      status: 400,
    };
  }

  return { ok: true, defaultEnvironmentName: parsed.value };
}

export function parseServerCapacityPutBody(
  body: Record<string, unknown>,
):
  | { ok: true; maxServers: number | null }
  | OrganizationRouteValidationError {
  if (!("maxServers" in body)) {
    return { ok: false, error: "Invalid request", status: 400 };
  }

  const parsed = parseMaxServersInput(body.maxServers);
  if (!parsed.ok) {
    return {
      ok: false,
      error: "maxServers must be a non-negative integer or null",
      status: 400,
    };
  }

  return { ok: true, maxServers: parsed.value };
}

export function parseOrganizationCreateDisplayName(
  body: Record<string, unknown>,
): { ok: true; displayName: string } | OrganizationRouteValidationError {
  try {
    const parsed = parseDisplayName({
      displayName: typeof body.displayName === "string"
        ? body.displayName
        : NEW_ORGANIZATION_DISPLAY_NAME,
    });
    return { ok: true, displayName: parsed ?? NEW_ORGANIZATION_DISPLAY_NAME };
  } catch (error) {
    if (error instanceof BadRequestError) {
      return { ok: false, error: "Invalid request", status: 400 };
    }
    throw error;
  }
}

/** PATCH requires a non-empty display name; it cannot be cleared. */
export function parseOrganizationPatchDisplayName(
  body: Record<string, unknown>,
): { ok: true; displayName: string } | OrganizationRouteValidationError {
  if (!("displayName" in body) && !("name" in body)) {
    return { ok: false, error: "Invalid request", status: 400 };
  }
  try {
    const parsed = parseDisplayName(body);
    if (parsed === null) {
      return { ok: false, error: "Invalid request", status: 400 };
    }
    return { ok: true, displayName: parsed };
  } catch (error) {
    if (error instanceof BadRequestError) {
      return { ok: false, error: "Invalid request", status: 400 };
    }
    throw error;
  }
}

export function toOrganizationRecord(row: {
  id: string;
  name: string | null;
  createdAt: string;
}): OrganizationSummary {
  return {
    id: row.id,
    displayName: row.name,
    createdAt: row.createdAt,
  };
}

export function defaultTimezoneGetResponse(options: {
  defaultServerTimezone?: string | null;
  enforceServerTimezone?: boolean | null;
}) {
  return {
    defaultServerTimezone: options.defaultServerTimezone ?? null,
    enforceServerTimezone: options.enforceServerTimezone ?? false,
  };
}

export function defaultEnvironmentGetResponse(options: {
  defaultEnvironmentName?: string | null;
}) {
  return {
    defaultEnvironmentName: options.defaultEnvironmentName ?? null,
  };
}

export function defaultTimezonePutResponse(options: {
  defaultServerTimezone?: string | null;
  enforceServerTimezone?: boolean | null;
}) {
  return {
    ok: true as const,
    ...defaultTimezoneGetResponse(options),
  };
}

export function hostDefaultsGetResponse(options: {
  sshPort?: number;
  ntp?: NtpDefaults;
  defaultFabricEnabled?: boolean;
}) {
  return {
    sshPort: options.sshPort ?? null,
    ntp: options.ntp ?? null,
    defaultFabricEnabled: options.defaultFabricEnabled ?? false,
  };
}

export function hostDefaultsPutResponse(options: {
  sshPort?: number;
  ntp?: NtpDefaults;
  defaultFabricEnabled?: boolean;
}) {
  return {
    ok: true as const,
    ...hostDefaultsGetResponse(options),
  };
}

export function defaultEnvironmentPutResponse(options: {
  defaultEnvironmentName?: string | null;
}) {
  return {
    ok: true as const,
    ...defaultEnvironmentGetResponse(options),
  };
}
