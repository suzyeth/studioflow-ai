// Metadata-server access tokens, cached until shortly before expiry.
//
// On Cloud Run (and Cloud Build) the metadata server mints OAuth tokens for the
// runtime service account — no key file, nothing to rotate, nothing in an env
// var. Both the Firestore mirror and the Veo renderer authenticate this way;
// each creates its own source, and the cache keeps one token fetch serving many
// calls rather than one per request.
//
// Zero dependencies, same as every other integration in this project.

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

function createTokenSource({ tokenUrl = METADATA_TOKEN_URL } = {}) {
  let cached = null;
  let expiresAt = 0;

  return {
    async getToken() {
      if (cached && Date.now() < expiresAt) {
        return cached;
      }
      const response = await fetch(tokenUrl, { headers: { "Metadata-Flavor": "Google" } });
      if (!response.ok) {
        throw new Error(`token endpoint answered HTTP ${response.status}`);
      }
      const payload = await response.json();
      if (!payload.access_token) {
        throw new Error("token endpoint returned no access_token");
      }
      cached = payload.access_token;
      // Refresh a minute early so a token never expires mid-request.
      expiresAt = Date.now() + Math.max(0, (payload.expires_in || 0) - 60) * 1000;
      return cached;
    },
  };
}

module.exports = { METADATA_TOKEN_URL, createTokenSource };
