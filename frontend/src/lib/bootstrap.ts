export interface Bootstrap {
  version: string
  ws_url: string
  auth_mode: string
  base_path: string
  config_path: string
  features: { diagnostics: boolean }
}

/** BASE_URL is '/control/static/dist/'; the API lives at '/control/api/'. */
export function bootstrapUrl(): string {
  const base = import.meta.env.BASE_URL.replace(/static\/dist\/?$/, '')
  return `${base}api/bootstrap`
}

export async function fetchBootstrap(): Promise<Bootstrap> {
  const resp = await fetch(bootstrapUrl())
  if (!resp.ok) throw new Error(`bootstrap failed: ${resp.status}`)
  return (await resp.json()) as Bootstrap
}
