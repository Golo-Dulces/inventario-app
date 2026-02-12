import { useEffect, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { supabase } from './supabaseClient'
import Login from './pages/Login'
import Products from './pages/Products'
import ProductDetail from './pages/ProductDetail'

export default function App() {
  const [session, setSession] = useState(null)
  const [booting, setBooting] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setBooting(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  async function logout() {
    await supabase.auth.signOut()
  }

  if (booting) return <div className="container"><p>Cargando…</p></div>
  if (!session) return <Login />

  const user = session.user

  return (
    <div>
      <div className="card" style={{ borderRadius: 0, borderLeft: 0, borderRight: 0 }}>
        <div className="container" style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <strong>Inventario</strong>
          <div className="row" style={{ alignItems:'center' }}>
            <small className="muted">{user.email}</small>
            <button onClick={logout}>Salir</button>
          </div>
        </div>
      </div>

      <Routes>
        <Route path="/" element={<Products user={user} />} />
        <Route path="/p/:id" element={<ProductDetail user={user} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  )
}
