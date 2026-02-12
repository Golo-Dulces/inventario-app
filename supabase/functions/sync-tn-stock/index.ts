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

type TNVariant = {
  id: number;
  sku?: string | null;
  stock?: number | string | null;
  inventory_levels?: Array<{ stock?: number | string | null }>;
};

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function calcStock(variant: TNVariant): number | null {
  const s = toNumber(variant.stock);
  if (s !== null) return s;

  if (Array.isArray(variant.inventory_levels)) {
    let acc = 0;
    let any = false;
    for (const lvl of variant.inventory_levels) {
      const ls = toNumber(lvl?.stock);
      if (ls !== null) { acc += ls; any = true; }
    }
    return any ? acc : null;
  }
  return null;
}

async function tnFetchProducts(page: number, perPage: number) {
  // Base URL y headers según doc oficial. :contentReference[oaicite:2]{index=2}
  const url = `https://api.tiendanube.com/${TN_VERSION}/${TN_STORE_ID}/products?page=${page}&per_page=${perPage}&fields=id,variants`;
  const res = await fetch(url, {
    headers: {
      "Authentication": `bearer ${TN_TOKEN}`,
      "User-Agent": TN_UA,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Tiendanube ${res.status}: ${t}`);
  }
  return await res.json();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) {
      return new Response(JSON.stringify({ error: "Falta Authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Cliente con JWT del usuario (para obtener owner_id)
    const supaUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: auth } },
    });

    const { data: userData, error: userErr } = await supaUser.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "No autorizado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const ownerId = userData.user.id;

    // Cliente admin (service role) para escribir sin pelear con RLS
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Variantes locales del dueño
    const { data: locals, error: lErr } = await admin
      .from("items")
      .select("id, sku")
      .eq("owner_id", ownerId)
      .eq("tipo", "variante");

    if (lErr) throw lErr;

    const skuToLocalId = new Map<string, string | number>();
    for (const it of locals ?? []) {
      const sku = String(it.sku ?? "").trim();
      if (sku) skuToLocalId.set(sku, it.id);
    }

    // Paginación: per_page hasta 200. :contentReference[oaicite:3]{index=3}
    const perPage = 200;
    let page = 1;

    const updates: Array<{
      id: string | number;
      tn_variant_id: number;
      tn_stock: number | null;
      tn_stock_updated_at: string;
    }> = [];

    let tnCount = 0;
    let matched = 0;

    while (true) {
      const products = await tnFetchProducts(page, perPage);
      if (!Array.isArray(products) || products.length === 0) break;

      for (const p of products) {
        const variants: TNVariant[] = Array.isArray(p?.variants) ? p.variants : [];
        for (const v of variants) {
          tnCount += 1;
          const sku = String(v?.sku ?? "").trim();
          if (!sku) continue;

          const localId = skuToLocalId.get(sku);
          if (!localId) continue;

          matched += 1;
          updates.push({
            id: localId,
            tn_variant_id: v.id,
            tn_stock: calcStock(v),
            tn_stock_updated_at: new Date().toISOString(),
          });
        }
      }

      if (products.length < perPage) break;
      page += 1;
    }

    // ✅ SOLO UPDATE (nunca inserta)
let written = 0;
const chunkSize = 50;

for (let i = 0; i < updates.length; i += chunkSize) {
  const batch = updates.slice(i, i + chunkSize);

  const results = await Promise.all(
    batch.map((u) =>
      admin
        .from("items")
        .update({
          tn_variant_id: u.tn_variant_id,
          tn_stock: u.tn_stock,
          tn_stock_updated_at: u.tn_stock_updated_at,
        })
        .eq("id", u.id)
        .eq("owner_id", ownerId)
        .eq("tipo", "variante")
    )
  );

  for (const r of results) {
    if (r.error) throw r.error;
    written += 1;
  }
}


    return new Response(
      JSON.stringify({
        ok: true,
        tn_variants_seen: tnCount,
        local_variants_with_sku: skuToLocalId.size,
        matched_by_sku: matched,
        rows_written: written,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message ?? e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
