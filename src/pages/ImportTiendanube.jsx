import { useState } from "react";
import Papa from "papaparse";
import { supabase } from "../supabaseClient";

function pickCol(headers, candidates) {
  const lower = headers.map(h => String(h).toLowerCase());
  for (const c of candidates) {
    const idx = lower.findIndex(h => h.includes(c));
    if (idx >= 0) return headers[idx];
  }
  return null;
}

export default function ImportTiendanube({ user }) {
  const [file, setFile] = useState(null);
  const [log, setLog] = useState([]);
  const [loading, setLoading] = useState(false);

  function push(msg) {
    setLog(prev => [...prev, msg]);
  }

  async function runImport() {
    if (!file) return alert("Elegí un CSV de Tiendanube");
    setLoading(true);
    setLog([]);

    try {
      const text = await file.text();

      const parsed = Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
      });

      if (parsed.errors?.length) {
        console.warn(parsed.errors);
        push(`⚠️ CSV con advertencias: ${parsed.errors[0].message}`);
      }

      const rows = parsed.data || [];
      if (!rows.length) throw new Error("El CSV no tiene filas (o no pude leerlo).");

      const headers = Object.keys(rows[0] || {});
      const colSlug = pickCol(headers, ["identificador de url", "identificador url", "url"]);
      const colName = pickCol(headers, ["nombre"]);
      const colSKU = pickCol(headers, ["sku"]);

      const prop1Name = pickCol(headers, ["nombre de propiedad 1"]);
      const prop1Val  = pickCol(headers, ["valor de propiedad 1"]);
      const prop2Name = pickCol(headers, ["nombre de propiedad 2"]);
      const prop2Val  = pickCol(headers, ["valor de propiedad 2"]);
      const prop3Name = pickCol(headers, ["nombre de propiedad 3"]);
      const prop3Val  = pickCol(headers, ["valor de propiedad 3"]);

      if (!colSlug || !colName || !colSKU) {
        throw new Error(`No encontré columnas necesarias. Necesito: "Identificador de URL", "Nombre", "SKU".`);
      }

      // Traer existentes para evitar duplicados
      push("Leyendo lo que ya existe en la app…");

      const { data: existingProducts, error: eP } = await supabase
        .from("items")
        .select("id, tn_slug")
        .eq("owner_id", user.id)
        .eq("tipo", "producto")
        .limit(5000);

      if (eP) throw eP;

      const { data: existingVariants, error: eV } = await supabase
        .from("items")
        .select("id, sku")
        .eq("owner_id", user.id)
        .eq("tipo", "variante")
        .limit(10000);

      if (eV) throw eV;

      const prodBySlug = new Map((existingProducts || []).filter(x => x.tn_slug).map(x => [x.tn_slug, x.id]));
      const skuSet = new Set((existingVariants || []).map(x => String(x.sku || "").trim()).filter(Boolean));

      // Agrupar por slug
      const bySlug = new Map();
      for (const r of rows) {
        const slug = String(r[colSlug] || "").trim();
        const name = String(r[colName] || "").trim();
        const sku  = String(r[colSKU] || "").trim();
        if (!slug || !name) continue;
        if (!bySlug.has(slug)) bySlug.set(slug, []);
        bySlug.get(slug).push({ r, sku, name });
      }

      push(`Detecté ${bySlug.size} productos (por slug).`);

      // 1) Crear productos faltantes
      let createdProducts = 0;
      for (const [slug, arr] of bySlug.entries()) {
        if (prodBySlug.has(slug)) continue;

        const name = arr[0].name;
        const { data: inserted, error } = await supabase
          .from("items")
          .insert([{
            owner_id: user.id,
            tipo: "producto",
            nombre: name,
            tn_slug: slug,
            publicar_precio: "minorista",
            pack_mayorista_unid: 1
          }])
          .select("id")
          .single();

        if (error) throw error;

        prodBySlug.set(slug, inserted.id);
        createdProducts += 1;
      }
      push(`✅ Productos creados: ${createdProducts}`);

      // 2) Crear variantes faltantes (por SKU)
      let createdVariants = 0;
      let skippedNoSKU = 0;
      let skippedDupSKU = 0;

      for (const [slug, arr] of bySlug.entries()) {
        const parentId = prodBySlug.get(slug);
        for (const { r, sku, name } of arr) {
          if (!sku) { skippedNoSKU += 1; continue; }
          if (skuSet.has(sku)) { skippedDupSKU += 1; continue; }

          const opt1 = prop1Val ? String(r[prop1Val] || "").trim() : "";
          const opt2 = prop2Val ? String(r[prop2Val] || "").trim() : "";
          const opt3 = prop3Val ? String(r[prop3Val] || "").trim() : "";

          const vname = [opt1, opt2, opt3].filter(Boolean).join(" / ") || name;

          const { error } = await supabase
            .from("items")
            .insert([{
              owner_id: user.id,
              tipo: "variante",
              parent_id: parentId,
              nombre: vname,
              sku: sku,
              opcion1: opt1 || null,
              opcion2: opt2 || null,
              opcion3: opt3 || null,
            }]);

          if (error) throw error;

          skuSet.add(sku);
          createdVariants += 1;
        }
      }

      push(`✅ Variantes creadas: ${createdVariants}`);
      if (skippedNoSKU) push(`⚠️ Filas sin SKU: ${skippedNoSKU} (no se importaron)`);
      if (skippedDupSKU) push(`ℹ️ SKUs ya existentes: ${skippedDupSKU} (se saltaron)`);
      push("🎉 Importación terminada.");

    } catch (e) {
      console.error(e);
      alert(e.message || String(e));
      push(`❌ Error: ${e.message || String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container">
      <h2 style={{ marginTop: 0 }}>Importar desde Tiendanube (CSV)</h2>

      <div className="card">
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
        />
        <div style={{ height: 10 }} />
        <button className="primary" onClick={runImport} disabled={loading}>
          {loading ? "Importando…" : "Importar CSV"}
        </button>
        <small className="muted" style={{ display: "block", marginTop: 10 }}>
          Importa productos + variantes y guarda el slug en tn_slug. No crea duplicados por SKU.
        </small>
      </div>

      {log.length > 0 && (
        <div className="card" style={{ marginTop: 12 }}>
          {log.map((l, i) => (
            <div key={i}><small className="muted">{l}</small></div>
          ))}
        </div>
      )}
    </div>
  );
}
