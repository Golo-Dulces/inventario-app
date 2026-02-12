import { supabase } from '../supabaseClient'
import { calcPrecios } from './pricing'

export async function recalcularCompuestos({ ownerId }) {
  // 1) Traer items necesarios
  const { data: items, error: e1 } = await supabase
    .from('items')
    .select(
      'id,owner_id,nombre,tipo,parent_id,es_compuesto,' +
        'costo_unitario_manual,unid_por_bulto,precio_bulto,' +
        'es_por_peso,peso_por_unidad_g,price_100g,margin_100g,' +
        'margen_minorista,margen_mayorista,pack_mayorista_unid'
    )
    .eq('owner_id', ownerId)
    .limit(5000)

  if (e1) throw e1

  // 2) Traer recetas
  const { data: recs, error: e2 } = await supabase
    .from('receta_componentes')
    .select('parent_item_id,component_item_id,unidad,cantidad')
    .eq('owner_id', ownerId)
    .limit(20000)

  if (e2) throw e2

  const itemsById = new Map((items || []).map(it => [it.id, it]))
  const recetaByParent = new Map()

  for (const r of recs || []) {
    if (!recetaByParent.has(r.parent_item_id)) recetaByParent.set(r.parent_item_id, [])
    recetaByParent.get(r.parent_item_id).push(r)
  }

  const memo = new Map()
  const visiting = new Set()
  const warnings = []
  const cycles = []

  function baseCosts(it) {
    const p = calcPrecios(it, 1)
    return {
      costUnit: p?.costo_unitario ?? null,
      cost100: p?.costo_100g ?? null,
    }
  }

  function costsForItem(id) {
    if (memo.has(id)) return memo.get(id)

    if (visiting.has(id)) {
      cycles.push(id)
      return { costUnit: null, cost100: null }
    }

    visiting.add(id)

    let it = itemsById.get(id)
    if (!it) {
      visiting.delete(id)
      return { costUnit: null, cost100: null }
    }

    // If a recipe line points to a variant, use parent product costs.
    if (it.tipo === 'variante' && it.parent_id) {
      const parent = itemsById.get(Number(it.parent_id))
      if (parent) it = parent
    }

    // No compuesto: costo directo
    if (!it.es_compuesto) {
      const c = baseCosts(it)
      memo.set(id, c)
      visiting.delete(id)
      return c
    }

    // Compuesto: sumar componentes
    const lines = recetaByParent.get(id) || []
    let total = 0
    let ok = true

    for (const line of lines) {
      const comp = costsForItem(line.component_item_id)

      if (line.unidad === 'unid') {
        if (comp.costUnit == null) {
          ok = false
          warnings.push(`Falta costo unitario en componente ID ${line.component_item_id} (para receta de ID ${id})`)
          continue
        }
        total += Number(line.cantidad) * Number(comp.costUnit)
      } else {
        // gramos
        if (comp.cost100 == null) {
          ok = false
          warnings.push(`Falta costo/100g en componente ID ${line.component_item_id} (para receta de ID ${id})`)
          continue
        }
        total += Number(line.cantidad) * (Number(comp.cost100) / 100)
      }
    }

    // Para que también pueda tener cost100 si el compuesto es “por peso”
    const temp = { ...it, costo_unitario_manual: ok ? total : null }
    const p = calcPrecios(temp, 1)
    const result = {
      costUnit: ok ? total : null,
      cost100: ok ? (p?.costo_100g ?? null) : null,
    }

    memo.set(id, result)
    visiting.delete(id)
    return result
  }

  // 3) Calcular todos los compuestos y guardar cache
  const compuestos = (items || []).filter(it => it.es_compuesto)

  let updated = 0
  for (const it of compuestos) {
    const c = costsForItem(it.id)
    if (c.costUnit == null) continue

    const { error: eUp } = await supabase
      .from('items')
      .update({
        costo_compuesto_cache: c.costUnit,
        costo_compuesto_calc_at: new Date().toISOString(),
      })
      .eq('id', it.id)
      .eq('owner_id', ownerId)

    if (eUp) throw eUp
    updated += 1
  }

  return { updated, warnings, cycles }
}
