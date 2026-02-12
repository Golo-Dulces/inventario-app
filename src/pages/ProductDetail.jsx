import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { calcPrecios } from '../lib/pricing'
import { recalcularCompuestos } from '../lib/recalcCompuestos'

export default function ProductDetail({ user }) {
  const { id } = useParams()
  const idNum = Number(id)

  const [product, setProduct] = useState(null)
  const [variants, setVariants] = useState([])
  const [redondeo, setRedondeo] = useState(1)
  const [saving, setSaving] = useState(false)

  // Receta (compuestos)
  const [receta, setReceta] = useState([])
  const [componentesCatalogo, setComponentesCatalogo] = useState([])
  const [nuevoCompId, setNuevoCompId] = useState('')
  const [nuevoCompUnidad, setNuevoCompUnidad] = useState('g')
  const [nuevoCompCantidad, setNuevoCompCantidad] = useState('')

  // UI states
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState('')
  const [publishingTN, setPublishingTN] = useState(false)
  const [recalcLoading, setRecalcLoading] = useState(false)

  async function loadRedondeo() {
    const { data, error } = await supabase
      .from('parametros')
      .select('valor')
      .eq('clave', 'redondeo')
      .maybeSingle()
    if (error) throw error

    const r = data?.valor ? Number(data.valor) : 1
    setRedondeo(Number.isFinite(r) ? r : 1)
  }

  async function loadAll() {
    if (!user?.id) return
    if (!Number.isFinite(idNum)) {
      setLoadErr('ID inválido en la URL.')
      setLoading(false)
      return
    }

    setLoading(true)
    setLoadErr('')

    try {
      await loadRedondeo()

      // Producto
      const { data: p, error: pErr } = await supabase
        .from('items')
        .select('*')
        .eq('id', idNum)
        .eq('owner_id', user.id)
        .maybeSingle()
      if (pErr) throw pErr

      setProduct(p || null)

      // Variantes
      const { data: v, error: vErr } = await supabase
        .from('items')
        .select('*')
        .eq('tipo', 'variante')
        .eq('parent_id', idNum)
        .eq('owner_id', user.id)
        .order('id', { ascending: true })
      if (vErr) throw vErr
      setVariants(v || [])

      // Receta del producto
      const { data: r, error: rErr } = await supabase
        .from('receta_componentes')
        .select('id, component_item_id, unidad, cantidad')
        .eq('parent_item_id', idNum)
        .eq('owner_id', user.id)
        .order('id', { ascending: true })
      if (rErr) throw rErr
      setReceta(r || [])

      // Catálogo de componentes (para calcular costos)
      const { data: cat, error: catErr } = await supabase
        .from('items')
        .select(
          'id,nombre,tipo,parent_id,' +
            'es_compuesto,costo_compuesto_cache,' +
            'costo_unitario_manual,unid_por_bulto,precio_bulto,' +
            'es_por_peso,peso_por_unidad_g,price_100g,margin_100g,' +
            'margen_minorista,margen_mayorista'
        )
        .eq('owner_id', user.id)
        .order('nombre', { ascending: true })
        .limit(800)
      if (catErr) throw catErr
      setComponentesCatalogo(cat || [])
    } catch (e) {
      console.error('ProductDetail loadAll error', e)
      setLoadErr(e?.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // Importante: esperar a tener user.id
    if (!user?.id) return
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idNum, user?.id])

  // Helpers para publish a TN (evita el “Bearer Bearer …” y muestra error claro)
  async function getJwt() {
    const { data, error } = await supabase.auth.getSession()
    if (error) throw error
    const jwt = data?.session?.access_token
    if (!jwt || jwt.split('.').length !== 3) throw new Error('No hay sesión válida (JWT). Cerrá sesión y volvé a entrar.')
    return jwt
  }

  async function publishThisProductToTN() {
  try {
    setPublishingTN(true)

    await getJwt()

    console.info('[push-tn-prices][product] request start', {
      ownerId: user?.id,
      productId: Number(id),
    })

    const { data: json, error: fnError } = await supabase.functions.invoke('push-tn-prices', {
      body: {
        scope: 'product',
        product_id: Number(id),
      },
    })

    if (fnError) {
      let detail = fnError.message ?? 'Error'
      if (fnError.context) {
        const errJson = await fnError.context.json().catch(() => null)
        if (errJson?.error) detail = errJson.error
        console.error('[push-tn-prices][product] request failed (http)', { fnError, errJson })
      } else {
        console.error('[push-tn-prices][product] request failed', fnError)
      }
      alert(`Error: ${detail}`)
      return
    }

    console.info('[push-tn-prices][product] request ok', json)
    if (json?.ok === false) {
      const updated = Number(json?.variants_updated ?? 0)
      const failed = Number(json?.failed_products?.length ?? 0)
      const firstError = json?.failed_products?.[0]?.error
      alert(`Publicacion parcial. Variantes actualizadas: ${updated}. Productos fallidos: ${failed}.${firstError ? ` Primer error: ${firstError}` : ''}`)
      return
    }
    if (Number(json?.variants_updated ?? 0) === 0) {
      const missingSku = Number(json?.missingSkuLocal?.length ?? 0)
      const missingInTN = Number(json?.missingInTN?.length ?? 0)
      const skippedNoPrice = Number(json?.skippedNoPrice?.length ?? 0)
      const firstSkipped = json?.skippedNoPrice?.[0]
      const detail = firstSkipped
        ? ` Primer skipped: id=${firstSkipped.local_variant_id}, sku=${firstSkipped.sku || '-'}, reason=${firstSkipped.reason}.`
        : ''
      alert(`Sin cambios para publicar. missingSkuLocal=${missingSku}, missingInTN=${missingInTN}, skippedNoPrice=${skippedNoPrice}.${detail}`)
      return
    }
    alert(`Listo. Variantes actualizadas: ${json?.variants_updated ?? 0}`)
  } catch (e) {
    console.error('[push-tn-prices][product] unexpected error', e)
    alert(e?.message ?? String(e))
  } finally {
    setPublishingTN(false)
  }
}


  // Costo de receta (calc) + diagnostico por linea
  const recetaCostState = useMemo(() => {
    const issues = new Map()
    if (!product?.es_compuesto) return { total: null, issues }
    if (!receta || receta.length === 0) return { total: 0, issues }

    const mapItems = new Map(componentesCatalogo.map(x => [x.id, x]))
    const resolveComponent = raw => {
      if (!raw) return null
      if (raw.tipo === 'variante' && raw.parent_id) {
        const parent = mapItems.get(Number(raw.parent_id))
        if (parent) return parent
      }
      return raw
    }
    let total = 0
    let isComplete = true

    for (const line of receta) {
      const raw = mapItems.get(line.component_item_id)
      const it = resolveComponent(raw)
      if (!it || it.id === idNum) {
        isComplete = false
        issues.set(line.id, 'Componente no encontrado')
        continue
      }

      const compForCalc =
        it?.es_compuesto
          ? { ...it, costo_unitario_manual: it.costo_compuesto_cache ?? it.costo_unitario_manual }
          : it

      const p = calcPrecios(compForCalc, redondeo)
      const costo_unit = p?.costo_unitario ?? null
      let costo_100g = p?.costo_100g ?? null

      // Fallback: if costo_100g is missing but peso_por_unidad_g exists, derive it from unit cost.
      if (costo_100g == null && costo_unit != null) {
        const pesoG = Number(it?.peso_por_unidad_g)
        if (Number.isFinite(pesoG) && pesoG > 0) {
          costo_100g = (Number(costo_unit) / pesoG) * 100
        }
      }

      if (line.unidad === 'unid') {
        if (costo_unit != null) {
          total += Number(line.cantidad) * Number(costo_unit)
        } else {
          isComplete = false
          issues.set(line.id, 'Falta costo unitario del componente')
        }
      } else {
        if (costo_100g != null) {
          total += Number(line.cantidad) * (Number(costo_100g) / 100)
        } else {
          isComplete = false
          issues.set(line.id, 'Falta costo/100g o peso por unidad (g)')
        }
      }
    }

    return { total: isComplete ? total : null, issues }
  }, [product?.es_compuesto, receta, componentesCatalogo, redondeo, idNum])
  const costoCompuesto = recetaCostState.total

  // Precios del producto (si es compuesto, usa costoCompuesto como costo unitario)
  const preciosProducto = useMemo(() => {
    if (!product) return null
    const overrideCosto = product.es_compuesto ? (product.costo_compuesto_cache ?? costoCompuesto) : null
    return calcPrecios(
      { ...product, costo_unitario_manual: overrideCosto ?? product.costo_unitario_manual },
      redondeo
    )
  }, [product, redondeo, costoCompuesto])

  async function saveProductPatch(patch) {
    setProduct(prev => ({ ...prev, ...patch }))
    setSaving(true)
    const { error } = await supabase
      .from('items')
      .update(patch)
      .eq('id', idNum)
      .eq('owner_id', user.id)
    setSaving(false)
    if (error) alert(error.message)
  }

  async function onRecalcularCompuestos() {
    try {
      setRecalcLoading(true)
      const res = await recalcularCompuestos({ ownerId: user.id })
      console.info('[recalcular-compuestos][detail] ok', res)
      await loadAll()
      alert(`Recalculo listo. Actualizados: ${res?.updated ?? 0}`)
    } catch (e) {
      console.error('[recalcular-compuestos][detail] error', e)
      alert(e?.message ?? String(e))
    } finally {
      setRecalcLoading(false)
    }
  }

  async function addVariant() {
    const nombre = prompt('Nombre variante:')
    if (!nombre) return

    const { error } = await supabase.from('items').insert([
      {
        tipo: 'variante',
        parent_id: idNum,
        nombre,
        owner_id: user.id,
        margen_minorista: product?.margen_minorista ?? 0,
        margen_mayorista: product?.margen_mayorista ?? 0,
        pack_mayorista_unid: product?.pack_mayorista_unid ?? 1,
      },
    ])

    if (error) alert(error.message)
    else loadAll()
  }

  async function updateVariant(variantId, patch) {
    setVariants(prev => prev.map(v => (v.id === variantId ? { ...v, ...patch } : v)))
    const { error } = await supabase
      .from('items')
      .update(patch)
      .eq('id', variantId)
      .eq('owner_id', user.id)
    if (error) alert(error.message)
  }

  if (!user?.id) {
    return (
      <div className="container">
        <p>No hay usuario (sesión). Volvé a iniciar sesión.</p>
        <Link to="/"><button>Volver</button></Link>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="container">
        <p>Cargando…</p>
        <Link to="/"><button>Volver</button></Link>
      </div>
    )
  }

  if (loadErr) {
    return (
      <div className="container">
        <p style={{ color: 'crimson' }}>Error: {loadErr}</p>
        <div className="row">
          <button onClick={loadAll}>Reintentar</button>
          <Link to="/"><button>Volver</button></Link>
        </div>
      </div>
    )
  }

  if (!product) {
    return (
      <div className="container">
        <p>No se encontró el producto (ID {String(id)}).</p>
        <div className="row">
          <button onClick={loadAll}>Reintentar</button>
          <Link to="/"><button>Volver</button></Link>
        </div>
      </div>
    )
  }

  const publicar = product.publicar_precio || 'minorista'
  const precioPublicado = publicar === 'mayorista' ? preciosProducto?.mayorista : preciosProducto?.minorista

  return (
    <div className="container">
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="row" style={{ alignItems: 'center' }}>
          <Link to="/"><button>{'<-'}</button></Link>
          <h2 style={{ margin: 0 }}>{product.nombre}</h2>
          {saving && <small className="muted">Guardando...</small>}
        </div>

        <div className="row">
          <button onClick={loadAll}>Refrescar</button>
          <button onClick={onRecalcularCompuestos} disabled={recalcLoading}>
            {recalcLoading ? 'Recalculando...' : 'Recalcular compuestos'}
          </button>
          <button className="primary" onClick={publishThisProductToTN} disabled={publishingTN}>
            {publishingTN ? 'Publicando TN...' : 'Publicar este producto (TN)'}
          </button>

        </div>
      </div>

      {/* PRODUCTO */}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="row">
          <input
            placeholder="Nombre"
            value={product.nombre || ''}
            onChange={e => saveProductPatch({ nombre: e.target.value })}
            style={{ flex: 2 }}
          />
          <input
            placeholder="Categoría"
            value={product.categoria || ''}
            onChange={e => saveProductPatch({ categoria: e.target.value })}
            style={{ flex: 1 }}
          />
          <input
            placeholder="Marca"
            value={product.marca || ''}
            onChange={e => saveProductPatch({ marca: e.target.value })}
            style={{ flex: 1 }}
          />
          <input
            placeholder="Tipo"
            value={product.tipo_producto || ''}
            onChange={e => saveProductPatch({ tipo_producto: e.target.value })}
            style={{ flex: 1 }}
          />
        </div>

        <div className="row" style={{ marginTop: 10 }}>
          <div className="field" style={{ flex: 1 }}>
            <div className="label">Costo unitario (manual)</div>
            <input
              type="number"
              step="any"
              value={product.costo_unitario_manual ?? ''}
              onChange={e =>
                saveProductPatch({
                  costo_unitario_manual: e.target.value === '' ? null : Number(e.target.value),
                })
              }
            />
            <div className="help muted">Opcional. Si lo completás, ignora el bulto.</div>
          </div>

          <div className="field" style={{ flex: 1 }}>
            <div className="label">Unid por bulto</div>
            <input
              type="number"
              step="any"
              value={product.unid_por_bulto ?? ''}
              onChange={e =>
                saveProductPatch({
                  unid_por_bulto: e.target.value === '' ? null : Number(e.target.value),
                })
              }
            />
            <div className="help muted">Si usás bulto: cuántas unidades trae.</div>
          </div>

          <div className="field" style={{ flex: 1 }}>
            <div className="label">Precio bulto</div>
            <input
              type="number"
              step="any"
              value={product.precio_bulto ?? ''}
              onChange={e =>
                saveProductPatch({
                  precio_bulto: e.target.value === '' ? null : Number(e.target.value),
                })
              }
            />
            <div className="help muted">Costo total del bulto/caja.</div>
          </div>

          <div className="field" style={{ flex: 1 }}>
            <div className="label">Stock mínimo</div>
            <input
              type="number"
              step="1"
              value={product.stock_minimo ?? 0}
              onChange={e => saveProductPatch({ stock_minimo: Number(e.target.value) })}
            />
            <div className="help muted">Alerta. 0 = sin alerta.</div>
          </div>
        </div>

        <div className="row" style={{ marginTop: 10 }}>
          <div className="field" style={{ flex: 1 }}>
            <div className="label">Margen minorista</div>
            <input
              type="number"
              step="0.01"
              value={product.margen_minorista ?? 0}
              onChange={e => saveProductPatch({ margen_minorista: Number(e.target.value) })}
            />
            <div className="help muted">Ej: 0.50 = 50%.</div>
          </div>

          <div className="field" style={{ flex: 1 }}>
            <div className="label">Margen mayorista</div>
            <input
              type="number"
              step="0.01"
              value={product.margen_mayorista ?? 0}
              onChange={e => saveProductPatch({ margen_mayorista: Number(e.target.value) })}
            />
            <div className="help muted">Ej: 0.30 = 30%.</div>
          </div>

          <div className="field" style={{ flex: 1 }}>
            <div className="label">Pack (unid)</div>
            <input
              type="number"
              step="1"
              value={product.pack_mayorista_unid ?? 1}
              onChange={e => saveProductPatch({ pack_mayorista_unid: Number(e.target.value) })}
            />
            <div className="help muted">1 = unitario. 5 = pack x5 (multiplica precios).</div>
          </div>

          <div className="field" style={{ flex: 1 }}>
            <div className="label">Precio a publicar</div>
            <select
              value={product.publicar_precio || 'minorista'}
              onChange={e => saveProductPatch({ publicar_precio: e.target.value })}
            >
              <option value="minorista">Publicar minorista</option>
              <option value="mayorista">Publicar mayorista</option>
            </select>
            <div className="help muted">Esto es lo que luego mandaremos a Tiendanube.</div>
          </div>
        </div>

        <div className="row" style={{ marginTop: 10 }}>
          <div className="field" style={{ flex: 1 }}>
            <div className="label">Venta por peso</div>
            <select
              value={product.es_por_peso ? '1' : '0'}
              onChange={e => saveProductPatch({ es_por_peso: e.target.value === '1' })}
            >
              <option value="0">No</option>
              <option value="1">Si</option>
            </select>
            <div className="help muted">Habilita calculo de precio por 100g.</div>
          </div>

          <div className="field" style={{ flex: 1 }}>
            <div className="label">Peso por unidad (g)</div>
            <input
              type="number"
              step="any"
              value={product.peso_por_unidad_g ?? ''}
              onChange={e =>
                saveProductPatch({
                  peso_por_unidad_g: e.target.value === '' ? null : Number(e.target.value),
                })
              }
            />
            <div className="help muted">Se usa para calcular costo 100g cuando no hay override.</div>
          </div>

          <div className="field" style={{ flex: 1 }}>
            <div className="label">Costo 100g (manual)</div>
            <input
              type="number"
              step="any"
              value={product.price_100g ?? ''}
              onChange={e =>
                saveProductPatch({
                  price_100g: e.target.value === '' ? null : Number(e.target.value),
                })
              }
            />
            <div className="help muted">Opcional. Si lo completas, reemplaza el calculo por peso.</div>
          </div>

          <div className="field" style={{ flex: 1 }}>
            <div className="label">Margen 100g</div>
            <input
              type="number"
              step="0.01"
              value={product.margin_100g ?? ''}
              onChange={e =>
                saveProductPatch({
                  margin_100g: e.target.value === '' ? null : Number(e.target.value),
                })
              }
            />
            <div className="help muted">Ej: 0.40 = 40% para venta por 100g.</div>
          </div>
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <span className="pill">Costo unitario (calc): {preciosProducto?.costo_unitario ?? '-'}</span>
          <span className="pill">Precio minorista (calc): {preciosProducto?.minorista ?? '-'}</span>
          <span className="pill">Precio mayorista (calc): {preciosProducto?.mayorista ?? '-'}</span>
          <span className="pill">Precio 100g (calc): {preciosProducto?.venta_100g ?? '-'}</span>
          <span className="pill">Precio publicado: {precioPublicado ?? '-'}</span>
        </div>
      </div>

      {/* RECETA */}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Producto compuesto</h3>
          <div className="row" style={{ alignItems: 'center' }}>
            <span className="pill">Costo receta (calc): {costoCompuesto ?? '-'}</span>
            <span className="pill muted">Cache: {product.costo_compuesto_cache ?? '-'}</span>
            {recetaCostState.issues.size > 0 && (
              <small className="muted" style={{ color: 'tomato' }}>
                Receta incompleta: {recetaCostState.issues.size} linea(s) con costo faltante.
              </small>
            )}
            <select
              value={product.es_compuesto ? '1' : '0'}
              onChange={e => saveProductPatch({ es_compuesto: e.target.value === '1' })}
            >
              <option value="0">0</option>
              <option value="1">1</option>
            </select>
          </div>
        </div>

        {product.es_compuesto && (
          <>
            <div className="row" style={{ marginTop: 10 }}>
              <select
                value={nuevoCompId}
                onChange={e => setNuevoCompId(e.target.value)}
                style={{ flex: 2 }}
              >
                <option value="">Seleccionar componente...</option>
                {componentesCatalogo
                  .filter(x => x.id !== idNum && x.tipo === 'producto')
                  .map(x => (
                    <option key={x.id} value={x.id}>
                      {x.nombre} (ID {x.id})
                    </option>
                  ))}
              </select>

              <select
                value={nuevoCompUnidad}
                onChange={e => setNuevoCompUnidad(e.target.value)}
                style={{ width: 120 }}
              >
                <option value="g">g</option>
                <option value="unid">unid</option>
              </select>

              <input
                placeholder="Cantidad"
                type="number"
                step="any"
                value={nuevoCompCantidad}
                onChange={e => setNuevoCompCantidad(e.target.value)}
                style={{ width: 140 }}
              />

              <button
                className="primary"
                onClick={async () => {
                  if (!nuevoCompId || !nuevoCompCantidad) return
                  const { error } = await supabase.from('receta_componentes').insert([
                    {
                      parent_item_id: idNum,
                      owner_id: user.id,
                      component_item_id: Number(nuevoCompId),
                      unidad: nuevoCompUnidad,
                      cantidad: Number(nuevoCompCantidad),
                    },
                  ])
                  if (error) return alert(error.message)
                  setNuevoCompId('')
                  setNuevoCompCantidad('')
                  loadAll()
                }}
              >
                + Agregar
              </button>
            </div>

            <div className="table-wrap">
              <table className="table" style={{ marginTop: 10 }}>
              <thead>
                <tr>
                  <th>Componente</th>
                  <th>Unidad</th>
                  <th>Cantidad</th>
                  <th>Estado costo</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {receta.map(line => {
                  const raw = componentesCatalogo.find(x => x.id === line.component_item_id)
                  const it =
                    raw?.tipo === 'variante' && raw?.parent_id
                      ? (componentesCatalogo.find(x => x.id === Number(raw.parent_id)) || raw)
                      : raw
                  const issue = recetaCostState.issues.get(line.id)
                  return (
                    <tr key={line.id}>
                      <td>
                        {it ? it.nombre : `ID ${line.component_item_id}`}
                        {raw?.tipo === 'variante' && (
                          <small className="muted" style={{ marginLeft: 8 }}>
                            (usa producto padre)
                          </small>
                        )}
                      </td>
                      <td>{line.unidad}</td>
                      <td>{line.cantidad}</td>
                      <td>
                        {issue ? <small style={{ color: 'tomato' }}>{issue}</small> : <small className="muted">OK</small>}
                      </td>
                      <td>
                        <button
                          onClick={async () => {
                            const { error } = await supabase
                              .from('receta_componentes')
                              .delete()
                              .eq('id', line.id)
                              .eq('owner_id', user.id)
                            if (error) return alert(error.message)
                            loadAll()
                          }}
                        >
                          Borrar
                        </button>
                      </td>
                    </tr>
                  )
                })}
                {receta.length === 0 && (
                  <tr>
                    <td colSpan="5">
                      <small className="muted">Sin componentes todavía</small>
                    </td>
                  </tr>
                )}
              </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* VARIANTES */}
      <div className="row" style={{ marginTop: 12, alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Variantes</h3>
        <button className="primary" onClick={addVariant}>+ Nueva variante</button>
      </div>

      <div className="card" style={{ marginTop: 10 }}>
        <div className="table-wrap">
          <table className="table">
          <thead>
            <tr>
              <th>Nombre variante</th>
              <th>SKU</th>
              <th>TN variant id</th>
              <th>Precio minorista (calc)</th>
              <th>Precio mayorista (calc)</th>
              <th>Precio 100g (calc)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {variants.map(v => {
              const pickNonEmpty = (a, b) => (a !== null && a !== undefined && a !== '' ? a : b)
              const pickPositive = (a, b) => {
                const an = Number(a)
                if (a !== null && a !== undefined && a !== '' && Number.isFinite(an) && an > 0) return an
                const bn = Number(b)
                if (b !== null && b !== undefined && b !== '' && Number.isFinite(bn) && bn > 0) return bn
                return null
              }
              const pickMargin = (a, b) => {
                const an = Number(a)
                if (a !== null && a !== undefined && a !== '' && Number.isFinite(an) && an > 0 && an < 1) return an
                const bn = Number(b)
                if (b !== null && b !== undefined && b !== '' && Number.isFinite(bn) && bn > 0 && bn < 1) return bn
                return null
              }
              const parentCostManual =
                product?.es_compuesto && product?.costo_compuesto_cache != null
                  ? product.costo_compuesto_cache
                  : product?.costo_unitario_manual
              const calcItem = {
                costo_unitario_manual: pickPositive(v.costo_unitario_manual, parentCostManual),
                unid_por_bulto: pickPositive(v.unid_por_bulto, product.unid_por_bulto),
                precio_bulto: pickPositive(v.precio_bulto, product.precio_bulto),
                margen_minorista: pickMargin(v.margen_minorista, product.margen_minorista),
                margen_mayorista: pickMargin(v.margen_mayorista, product.margen_mayorista),
                pack_mayorista_unid: product.pack_mayorista_unid,
                es_por_peso: pickNonEmpty(v.es_por_peso, product.es_por_peso),
                peso_por_unidad_g: pickPositive(v.peso_por_unidad_g, product.peso_por_unidad_g),
                price_100g: pickPositive(v.price_100g, product.price_100g),
                margin_100g: pickMargin(v.margin_100g, product.margin_100g),
              }
              const pv = calcPrecios(calcItem, redondeo)

              return (
                <tr key={v.id}>
                  <td>
                    <input value={v.nombre || ''} onChange={e => updateVariant(v.id, { nombre: e.target.value })} />
                  </td>
                  <td>
                    <input value={v.sku || ''} onChange={e => updateVariant(v.id, { sku: e.target.value })} />
                  </td>
                  <td>
                    <input
                      type="number"
                      step="1"
                      value={v.tn_variant_id ?? ''}
                      onChange={e =>
                        updateVariant(v.id, { tn_variant_id: e.target.value === '' ? null : Number(e.target.value) })
                      }
                    />
                  </td>
                  <td>{pv?.minorista ?? '-'}</td>
                  <td>{pv?.mayorista ?? '-'}</td>
                  <td>{pv?.venta_100g ?? '-'}</td>
                  <td><small className="muted">ID {v.id}</small></td>
                </tr>
              )
            })}

            {variants.length === 0 && (
              <tr><td colSpan="7"><small className="muted">Sin variantes todavía</small></td></tr>
            )}
          </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}


