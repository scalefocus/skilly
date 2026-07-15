// SCIM 2.0 endpoints for Entra provisioning. Phase 1 (SKILLY_SPEC.md §5).
// INVARIANT: authoritative source of users/groups/memberships. Roles live in
// role_mappings, not here.
//
// Entra's SCIM has quirks (PATCH op semantics, filter grammar, pagination). This
// implements the common create/update/membership/deprovision paths; full filter +
// pagination conformance is a dedicated test+hardening task (SKILLY_SPEC.md §14, §17).
import { Router, type Request } from "express";
import { constantTimeEqual } from "@skilly/shared";
import type { ScimStore, ScimUserRecord, ScimGroupRecord } from "./store.js";
import { parseScimFilter, parsePaging } from "./filter.js";

function requireScimAuth(token: string | undefined): boolean {
  const expected = process.env.SCIM_BEARER_TOKEN;
  return !!expected && !!token && constantTimeEqual(token, `Bearer ${expected}`);
}

// --- payload mappers (Entra SCIM core schema -> our store shape) ---
interface ScimUserResource {
  externalId?: string;
  id?: string;
  userName?: string;
  displayName?: string;
  active?: boolean;
  emails?: { value: string; primary?: boolean }[];
}
function toScimUser(body: ScimUserResource) {
  const externalId = body.externalId ?? body.id ?? "";
  const primaryEmail =
    body.emails?.find((e) => e.primary)?.value ?? body.emails?.[0]?.value ?? body.userName ?? "";
  return {
    externalId,
    email: primaryEmail,
    displayName: body.displayName ?? body.userName ?? primaryEmail,
    active: body.active ?? true,
  };
}

interface ScimPatch {
  Operations?: { op: string; path?: string; value?: unknown }[];
}

export function scimRouter(store: ScimStore): Router {
  const r = Router();

  r.use((req, res, next) => {
    if (!requireScimAuth(req.header("authorization"))) {
      return res
        .status(401)
        .json({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "401" });
    }
    next();
  });

  // ---------------- Users ----------------
  r.post("/Users", async (req, res, next) => {
    try {
      const u = toScimUser(req.body as ScimUserResource);
      if (!u.externalId) return scimError(res, 400, "externalId required");
      const { id } = await store.upsertUser(u);
      res.status(201).json(userResponse(id, u));
    } catch (e) {
      next(e);
    }
  });

  // PUT replaces; we treat as upsert keyed on externalId.
  r.put("/Users/:id", async (req, res, next) => {
    try {
      const u = toScimUser({ ...(req.body as ScimUserResource), externalId: extId(req) });
      const { id } = await store.upsertUser(u);
      res.json(userResponse(id, u));
    } catch (e) {
      next(e);
    }
  });

  // PATCH — Entra commonly toggles `active` here (soft delete / leaver). Entra serializes this
  // several ways; treat any of them as deprovision to avoid a disabled leaver retaining access
  // + tokens (audit F4): (a) path "active" with boolean false OR string "false"/"False";
  // (b) the path-less form {op:"replace", value:{active:false}}.
  r.patch("/Users/:id", async (req, res, next) => {
    try {
      const ops = (req.body as ScimPatch).Operations ?? [];
      const isFalse = (v: unknown) => v === false || (typeof v === "string" && v.trim().toLowerCase() === "false");
      const deactivates = ops.some((o) => {
        const path = (o.path ?? "").toLowerCase();
        if (path === "active") return isFalse(o.value);
        if (!path && o.value && typeof o.value === "object") return isFalse((o.value as Record<string, unknown>).active);
        return false;
      });
      if (deactivates) {
        await store.deprovisionUser(extId(req));
        return res.status(204).end();
      }
      // Other attribute patches: no-op (full PATCH path/value grammar is a conformance task).
      return res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  // DELETE — permanent removal => full GDPR erasure (SKILLY_SPEC.md §4/§5): scrub + detach the
  // user, delete their personal data, remove their maintainerships (no transfer). Skills stay;
  // messages/reviews become "Deleted User". Idempotent (no-op if already erased). The reversible
  // "leaver" disable is the PATCH active:false path above (deprovisionUser), NOT this.
  r.delete("/Users/:id", async (req, res, next) => {
    try {
      await store.eraseUserByExternalId(extId(req));
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  // ---------------- Groups ----------------
  r.post("/Groups", async (req, res, next) => {
    try {
      const body = req.body as { externalId?: string; id?: string; displayName?: string };
      const externalId = body.externalId ?? body.id ?? "";
      if (!externalId) return scimError(res, 400, "externalId required");
      const { id } = await store.upsertGroup({ externalId, displayName: body.displayName ?? externalId });
      res.status(201).json({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        id,
        externalId,
        displayName: body.displayName,
      });
    } catch (e) {
      next(e);
    }
  });

  // PATCH — membership add/remove (Entra sends op=add/remove, path="members").
  r.patch("/Groups/:id", async (req, res, next) => {
    try {
      const groupExtId = extId(req);
      const ops = (req.body as ScimPatch).Operations ?? [];
      for (const op of ops) {
        if ((op.path ?? "").toLowerCase() !== "members") continue;
        const members = (op.value as { value: string }[] | undefined) ?? [];
        for (const m of members) {
          if (op.op.toLowerCase() === "add") await store.addMembership(groupExtId, m.value);
          else if (op.op.toLowerCase() === "remove") await store.removeMembership(groupExtId, m.value);
        }
      }
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  r.delete("/Groups/:id", async (_req, res) => {
    // We keep groups for audit/provenance; membership cascade handles access.
    // Mark-and-keep semantics could be added if Entra requires hard delete.
    res.status(204).end();
  });

  // ---------------- List + get (filter + pagination) ----------------
  r.get("/Users", async (req, res, next) => {
    try {
      const filter = parseScimFilter(req.query.filter);
      const { startIndex, count } = parsePaging(req.query.startIndex, req.query.count);
      const { total, resources } = await store.listUsers({ filter, startIndex, count });
      res.json(listResponse(total, startIndex, resources.map(toUserResource)));
    } catch (e) {
      next(e);
    }
  });

  r.get("/Users/:id", async (req, res, next) => {
    try {
      const u = await store.findUserByExternalId(extId(req));
      if (!u) return scimError(res, 404, "user not found");
      res.json(toUserResource(u));
    } catch (e) {
      next(e);
    }
  });

  r.get("/Groups", async (req, res, next) => {
    try {
      const filter = parseScimFilter(req.query.filter);
      const { startIndex, count } = parsePaging(req.query.startIndex, req.query.count);
      const { total, resources } = await store.listGroups({ filter, startIndex, count });
      res.json(listResponse(total, startIndex, resources.map(toGroupResource)));
    } catch (e) {
      next(e);
    }
  });

  r.get("/Groups/:id", async (req, res, next) => {
    try {
      const g = await store.findGroupByExternalId(extId(req));
      if (!g) return scimError(res, 404, "group not found");
      res.json(toGroupResource(g));
    } catch (e) {
      next(e);
    }
  });

  return r;
}

function toUserResource(u: ScimUserRecord) {
  return userResponse(u.id, u);
}
function toGroupResource(g: ScimGroupRecord) {
  return { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], id: g.id, externalId: g.externalId, displayName: g.displayName };
}

function listResponse(total: number, startIndex: number, resources: unknown[]) {
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: total,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

// Entra addresses resources by the SCIM `id` we returned (our internal id) OR by
// externalId depending on config; here :id carries the Entra object id in our setup.
function extId(req: Request): string {
  // Express 5 types route params as string | string[]; :id is a single segment at runtime.
  const id = req.params.id;
  return (Array.isArray(id) ? id[0] : id) ?? "";
}

function userResponse(id: string, u: { externalId: string; email: string; displayName: string; active: boolean }) {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id,
    externalId: u.externalId,
    userName: u.email,
    displayName: u.displayName,
    active: u.active,
    emails: [{ value: u.email, primary: true }],
  };
}

import type { Response } from "express";
function scimError(res: Response, status: number, detail: string) {
  return res.status(status).json({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    status: String(status),
    detail,
  });
}
