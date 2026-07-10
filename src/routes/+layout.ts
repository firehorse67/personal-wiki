// The whole app sits behind a browser-side auth gate (Supabase session +
// MFA state live in localStorage) and the offline layer is IndexedDB, so
// nothing here can meaningfully render on the server.
export const ssr = false;
