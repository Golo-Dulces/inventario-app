import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;

const TN_STORE_ID = Deno.env.get("TIENDANUBE_STORE_ID")!;
const TN_TOKEN = Deno.env.get("TIENDANUBE_TOKEN")!;
const TN_UA = Deno.env.get("TIENDANUBE_USER_AGENT")!;
const TN_VERSION = Deno.env.get("TIENDANUBE_API_VERSION") ?? "2025-03";

type Scope = "product" | "all";
type ReqBody = { scope?: Scope; product_id?: number | string; owner_id?: string };

type LocalProduct = {
  id: number;
  owner_id: string;
  es_compuesto?: boolean | null;
  costo_compuesto_cache?: number | null;
  publicar_precio?: string | null;
  costo_unitario_manual?: number | null;
  unid_por_bulto?: number | null;
  precio_bulto?: number | null;
  margen_minorista?: number | null;
  margen_mayorista?: number | null;
  pack_mayorista_unid?: number | null;
};

type LocalVariant = {
  id: number;
  owner_id: string;
  parent_id: number | null;
  sku?: string | null;
  tn_variant_id?: number | null;
  costo_unitario_manual?: number | null;
  unid_por_bulto?: number | null;
  precio_bulto?: number | null;
  margen_minorista?: number | null;
  margen_mayorista?: number | null;
};

type TNVariant = { id: number; sku?: string | null };
type TNProduct = { id: number; variants?: TNVariant[] };

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function normalizeSku(v: unknown): string {
  return String(v ?? "").trim().toUpperCase();
}

function ceilToStep(value: number, step: number): number | null {
  if (!Number.isFinite(value)) return null;
  const s = Number.isFinite(step) && step > 0 ? step : 1;
  return Math.ceil(value / s) * s;
}

function roundToStep(value: number, step: number): number | null {
  if (!Number.isFinite(value)) return null;
  const s = Number.isFinite(step) && step > 0 ? step : 1;
  return Math.round((value + Number.EPSILON) / s) * s;
}

function calcCostUnit(p: { costo_unitario_manual?: unknown; unid_por_bulto?: unknown; precio_bulto?: unknown }): number | null {
  const manual = toNumber(p.costo_unitario_manual);
  if (manual !== null && manual > 0) return manual;

  const unid = toNumber(p.unid_por_bulto);
  const bulto = toNumber(p.precio_bulto);
  if (unid !== null && unid > 0 && bulto !== null && bulto >= 0) return bulto / unid;
  return null;
}

function calcUnitSalePrice(costUnit: number, margin: number, redondeoStep: number): number | null {
  if (!Number.isFinite(costUnit) || costUnit <= 0) return null;
  if (!Number.isFinite(margin) || margin <= 0 || margin >= 1) return null;
  return ceilToStep(costUnit / (1 - margin), redondeoStep);
}

function resolveMargin(variantMargin: unknown, productMargin: unknown): number | null {
  const vm = toNumber(variantMargin);
  if (vm !== null && vm > 0 && vm < 1) return vm;

  const pm = toNumber(productMargin);
  if (pm !== null && pm > 0 && pm < 1) return pm;

  return null;
}

function calcFinalPackPrice(unitPrice: number | null, pack: number, finalStep: number): number | null {
  if (unitPrice === null) return null;
  const pk = Number.isFinite(pack) && pack > 0 ? pack : 1;
  const raw = unitPrice * pk;
  const final = roundToStep(raw, finalStep);
  if (final === null) return null;
  if (raw > 0 && final <= 0 && Number.isFinite(finalStep) && finalStep > 0) return finalStep;
  return Math.max(0, final);
}

async function tnFetchProducts(page: number, perPage: number): Promise<TNProduct[]> {
  const url = `https://api.tiendanube.com/${TN_VERSION}/${TN_STORE_ID}/products?page=${page}&per_page=${perPage}&fields=id,variants`;
  const res = await fetch(url, {
    headers: {
      Authentication: `bearer ${TN_TOKEN}`,
      "User-Agent": TN_UA,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`Tiendanube ${res.status}: ${await res.text()}`);
  return await res.json();
}

async function tnPatchVariants(productId: number, payload: Array<Record<string, unknown>>) {
  const url = `https://api.tiendanube.com/${TN_VERSION}/${TN_STORE_ID}/products/${productId}/variants`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authentication: `bearer ${TN_TOKEN}`,
      "User-Agent": TN_UA,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Tiendanube PATCH ${productId} -> ${res.status}: ${await res.text()}`);
  }
  return await res.json();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      console.warn("[push-tn-prices] Missing or invalid Authorization header", {
        hasAuthorization: Boolean(authHeader),
      });
      return new Response(JSON.stringify({ ok: false, error: "No autorizado: falta Bearer token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData?.user?.id) {
      console.warn("[push-tn-prices] Unauthorized user", {
        authError: authError?.message ?? null,
      });
      return new Response(JSON.stringify({ ok: false, error: "No autorizado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const ownerId = authData.user.id;

    const body: ReqBody = (await req.json().catch(() => ({}))) as ReqBody;
    const scope: Scope = body.scope === "product" ? "product" : "all";
    const productId = body.product_id !== undefined ? Number(body.product_id) : null;

    console.info("[push-tn-prices] Request accepted", {
      scope,
      requestedProductId: productId,
      ownerId,
      hasBodyOwnerId: Boolean(body.owner_id),
    });

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Keep pricing behavior aligned with frontend calcPrecios().
    const finalRoundStep = 50;
    let redondeoStep = 1;
    const { data: redondeoParam, error: redondeoErr } = await admin
      .from("parametros")
      .select("valor")
      .eq("clave", "redondeo")
      .maybeSingle();
    if (redondeoErr) {
      console.warn("[push-tn-prices] Could not load parametros.redondeo, using default 1", {
        error: redondeoErr.message,
      });
    } else {
      const parsed = toNumber(redondeoParam?.valor);
      if (parsed !== null && parsed > 0) redondeoStep = parsed;
    }

    let products: LocalProduct[] = [];
    let variants: LocalVariant[] = [];

    if (scope === "product") {
      if (!productId || !Number.isFinite(productId)) {
        throw new Error("scope=product requiere product_id");
      }

      const { data: p, error: pErr } = await admin
        .from("items")
        .select(
          "id, owner_id, es_compuesto, costo_compuesto_cache, publicar_precio, costo_unitario_manual, unid_por_bulto, precio_bulto, margen_minorista, margen_mayorista, pack_mayorista_unid",
        )
        .eq("owner_id", ownerId)
        .eq("tipo", "producto")
        .eq("id", productId)
        .maybeSingle();
      if (pErr) throw pErr;
      if (!p) throw new Error("Producto no encontrado");
      products = [p as LocalProduct];

      const { data: v, error: vErr } = await admin
        .from("items")
        .select(
          "id, owner_id, parent_id, sku, tn_variant_id, costo_unitario_manual, unid_por_bulto, precio_bulto, margen_minorista, margen_mayorista",
        )
        .eq("owner_id", ownerId)
        .eq("tipo", "variante")
        .eq("parent_id", productId);
      if (vErr) throw vErr;
      variants = (v ?? []) as LocalVariant[];
    } else {
      const { data: p, error: pErr } = await admin
        .from("items")
        .select(
          "id, owner_id, es_compuesto, costo_compuesto_cache, publicar_precio, costo_unitario_manual, unid_por_bulto, precio_bulto, margen_minorista, margen_mayorista, pack_mayorista_unid",
        )
        .eq("owner_id", ownerId)
        .eq("tipo", "producto");
      if (pErr) throw pErr;
      products = (p ?? []) as LocalProduct[];

      const { data: v, error: vErr } = await admin
        .from("items")
        .select(
          "id, owner_id, parent_id, sku, tn_variant_id, costo_unitario_manual, unid_por_bulto, precio_bulto, margen_minorista, margen_mayorista",
        )
        .eq("owner_id", ownerId)
        .eq("tipo", "variante");
      if (vErr) throw vErr;
      variants = (v ?? []) as LocalVariant[];
    }

    const prodById = new Map<number, LocalProduct>();
    for (const p of products) prodById.set(p.id, p);

    const perPage = 200;
    let page = 1;
    const skuToTN = new Map<string, { product_id: number; variant_id: number }>();
    const variantIdToTN = new Map<number, { product_id: number; variant_id: number }>();
    while (true) {
      const tnProducts: TNProduct[] = await tnFetchProducts(page, perPage);
      if (!Array.isArray(tnProducts) || tnProducts.length === 0) break;

      for (const p of tnProducts) {
        const pid = Number(p.id);
        for (const vv of p.variants ?? []) {
          const tnVariantId = Number(vv.id);
          variantIdToTN.set(tnVariantId, { product_id: pid, variant_id: tnVariantId });
          const sku = normalizeSku(vv.sku);
          if (!sku) continue;
          skuToTN.set(sku, { product_id: pid, variant_id: tnVariantId });
        }
      }

      if (tnProducts.length < perPage) break;
      page += 1;
    }

    const missingSkuLocal: Array<{ local_variant_id: number }> = [];
    const missingInTN: Array<{ sku: string; local_variant_id: number; tn_variant_id?: number | null }> = [];
    const skippedNoPrice: Array<{ sku: string; local_variant_id: number; reason: string }> = [];

    const byProduct = new Map<number, Array<{ id: number; price: string }>>();

    for (const v of variants) {
      const sku = normalizeSku(v.sku);
      const localTnVariantId = toNumber(v.tn_variant_id);
      if (!sku && localTnVariantId === null) {
        missingSkuLocal.push({ local_variant_id: v.id });
        continue;
      }

      const prod = v.parent_id ? prodById.get(Number(v.parent_id)) : undefined;
      if (!prod) {
        skippedNoPrice.push({ sku, local_variant_id: v.id, reason: "Sin producto padre" });
        continue;
      }

      const pick = <T>(a: T | null | undefined, b: T | null | undefined) =>
        a !== null && a !== undefined && (typeof a !== "string" || a !== "") ? a : b;

      const parentCostManual =
        prod.es_compuesto && toNumber(prod.costo_compuesto_cache) !== null
          ? toNumber(prod.costo_compuesto_cache)
          : prod.costo_unitario_manual;

      const costUnit = calcCostUnit({
        costo_unitario_manual: pick(v.costo_unitario_manual, parentCostManual),
        unid_por_bulto: pick(v.unid_por_bulto, prod.unid_por_bulto),
        precio_bulto: pick(v.precio_bulto, prod.precio_bulto),
      });
      if (costUnit === null) {
        skippedNoPrice.push({ sku, local_variant_id: v.id, reason: "Sin costo unitario" });
        continue;
      }

      const pack = toNumber(prod.pack_mayorista_unid) ?? 1;
      const marginMinor = resolveMargin(v.margen_minorista, prod.margen_minorista);
      const marginMayor = resolveMargin(v.margen_mayorista, prod.margen_mayorista);

      const minorUnit = marginMinor !== null ? calcUnitSalePrice(costUnit, marginMinor, redondeoStep) : null;
      const mayorUnit = marginMayor !== null ? calcUnitSalePrice(costUnit, marginMayor, redondeoStep) : null;
      const minor = calcFinalPackPrice(minorUnit, pack, finalRoundStep);
      const mayor = calcFinalPackPrice(mayorUnit, pack, finalRoundStep);

      const pub = (prod.publicar_precio ?? "minorista") === "mayorista" ? "mayorista" : "minorista";
      const price = pub === "mayorista" ? mayor : minor;
      if (price === null) {
        skippedNoPrice.push({ sku, local_variant_id: v.id, reason: "Sin precio calculado" });
        continue;
      }

      let tn = sku ? skuToTN.get(sku) : undefined;
      if (!tn && localTnVariantId !== null) {
        tn = variantIdToTN.get(Math.trunc(localTnVariantId));
      }
      if (!tn) {
        missingInTN.push({ sku, local_variant_id: v.id, tn_variant_id: localTnVariantId });
        continue;
      }

      if (!byProduct.has(tn.product_id)) byProduct.set(tn.product_id, []);
      byProduct.get(tn.product_id)!.push({ id: tn.variant_id, price: String(Math.round(price)) });
    }

    const results: Array<{ product_id: number; updated: number }> = [];
    const failedProducts: Array<{ product_id: number; attempted: number; error: string }> = [];
    for (const [pid, payload] of byProduct.entries()) {
      if (payload.length === 0) continue;

      try {
        await tnPatchVariants(pid, payload);
        results.push({ product_id: pid, updated: payload.length });
      } catch (patchError) {
        const errorMessage = patchError instanceof Error ? patchError.message : String(patchError);
        failedProducts.push({
          product_id: pid,
          attempted: payload.length,
          error: errorMessage,
        });
        console.error("[push-tn-prices] PATCH failed", {
          productId: pid,
          attempted: payload.length,
          error: errorMessage,
        });
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    const responsePayload = {
      ok: failedProducts.length === 0,
      partial: failedProducts.length > 0 && results.length > 0,
      scope,
      requested_product_id: productId,
      products_touched: results.length,
      variants_updated: results.reduce((a, b) => a + b.updated, 0),
      per_product: results,
      failed_products: failedProducts,
      missingSkuLocal,
      missingInTN,
      skippedNoPrice,
    };

    console.info("[push-tn-prices] Completed", {
      scope,
      ownerId,
      requestedProductId: productId,
      productsTouched: responsePayload.products_touched,
      variantsUpdated: responsePayload.variants_updated,
      failedProducts: failedProducts.length,
      missingSkuLocal: missingSkuLocal.length,
      missingInTN: missingInTN.length,
      skippedNoPrice: skippedNoPrice.length,
    });

    return new Response(JSON.stringify(responsePayload), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[push-tn-prices] Unhandled error", e);
    return new Response(JSON.stringify({ ok: false, error: e?.message ?? String(e) }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
