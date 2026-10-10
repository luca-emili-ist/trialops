// Signature manifestation (CMP-11) and AI provenance marker (CMP-09): shown beside the content they qualify.
import { signatureManifestText, aiProvenanceText, type SignatureLike, type AiProvenanceLike } from './manifest.ts';

export function SignatureManifest({ signature, empty = 'Not signed' }: { signature: SignatureLike | null | undefined; empty?: string }) {
  if (!signature) return <span className="t-muted">{empty}</span>;
  return (
    <span className="sig-manifest" data-signature-id={signature.id}>
      <span className="sig-manifest-mark" aria-hidden="true">✓</span>
      <span>{signatureManifestText(signature)}</span>
    </span>
  );
}

export function AiProvenance({ provenance }: { provenance: AiProvenanceLike | null | undefined }) {
  if (!provenance) return null;
  return (
    <span className="ai-provenance" data-ai-request-id={provenance.ai_request_id ?? undefined}>
      <span className="ai-badge">AI</span>
      <span>{aiProvenanceText(provenance)}</span>
    </span>
  );
}
