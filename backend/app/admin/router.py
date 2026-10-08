"""``/api/admin/*``: the router the admin handlers are added to (docs/features/admin).

Handlers are added with ``@router.get(...)`` etc. on the router from ``new_admin_router()``; every route of
it uses ``AdminRoute`` (admins only, 404-identical denial for everyone else, ``admin_request`` logging).
The routes stay out of the OpenAPI document that ``/api/openapi.json`` serves without sign-in, so the public
schema doesn't tell anyone which admin actions exist (AC-31).
"""
from __future__ import annotations

from fastapi import APIRouter

from .authz import ADMIN_PREFIX, AdminRoute


def new_admin_router() -> APIRouter:
    return APIRouter(prefix=ADMIN_PREFIX, route_class=AdminRoute, include_in_schema=False)


router = new_admin_router()
