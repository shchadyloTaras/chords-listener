// Build-time configuration of the hosted web service (docs/CLOUD.md).

/**
 * Cloud API (Cloud Run service `chords-api`, europe-west1) used by signed-in users of the hosted site.
 * `VITE_CLOUD_API_URL` overrides it at build time (the Pages workflow, a local test server); otherwise the
 * deployed service below is used.
 */
export const CLOUD_API_URL: string =
  import.meta.env.VITE_CLOUD_API_URL || 'https://chords-api-84488579848.europe-west1.run.app'
