import type { ModelCatalog, ModelSetupStatus } from '../backendClient';
import { setupActive } from '../modelSetupMonitor';
import { escapeHtml } from './safeMarkdown';

export function catalogSourceUrl(value: string, hostname: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === hostname && !url.username && !url.password
      && !url.port && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}

export function readyCatalogModel(catalogId: string | null, status: ModelSetupStatus): string | null {
  if (!catalogId || status.catalog_id !== catalogId || !status.explicit_selection || status.state !== 'ready'
    || !status.model || !status.available_models.includes(status.model)) return null;
  return status.model;
}

export function renderModelCatalog(catalog: ModelCatalog | null, setup: ModelSetupStatus | null,
  options: { loading: boolean; pending: boolean; streaming: boolean; error: string }): string {
  const active = !!setup && (setupActive(setup.state) || !setup.can_retry);
  const disabled = options.pending || options.streaming || active || !catalog?.download_supported;
  const cards = catalog?.models.map(model => {
    const installed = setup?.provider === 'ollama' ? setup.available_models.some(name =>
      name === model.ollama_model || name.replace(/:latest$/, '') === model.ollama_model.replace(/:latest$/, '')) : model.installed;
    const hf = catalogSourceUrl(model.hugging_face_url, 'huggingface.co');
    const ollama = catalogSourceUrl(model.ollama_url, 'ollama.com');
    return `<article class="coding-model-card">
      <div class="coding-model-title"><strong>${escapeHtml(model.name)}</strong><span>${escapeHtml(model.tier)}</span></div>
      ${model.recommended ? '<small class="coding-model-pick">Workstation recommendation</small>' : ''}
      <p>${escapeHtml(model.description)}</p><small>${escapeHtml(model.memory_guidance)}</small>
      <small>${Number.isFinite(model.download_size_gb) ? `About ${model.download_size_gb} GB download` : 'Download size varies'} · ${escapeHtml(model.license)}</small>
      <small>${escapeHtml(model.validation_note || 'Research recommendation; not yet evaluated in CodeMe.')}</small>
      <div class="coding-model-actions">${hf ? `<a href="${escapeHtml(hf)}" rel="noopener noreferrer">Hugging Face</a>` : ''}${ollama ? `<a href="${escapeHtml(ollama)}" rel="noopener noreferrer">Ollama</a>` : ''}
      <button data-action="chooseCatalogModel" data-catalog-id="${escapeHtml(model.id)}" ${disabled ? 'disabled' : ''}>${installed ? 'Use installed model' : model.installed === null ? 'Check / download and use' : 'Download and use'}</button></div>
    </article>`;
  }).join('') || '';
  return `<section class="coding-model-catalog" aria-label="Coding model downloads">
    <div class="coding-model-title"><strong id="coding-models-title" tabindex="-1">Choose a local coding model</strong><button class="secondary" data-action="toggleModelCatalog" aria-label="Close coding models">Close</button></div>
    <p>Free downloadable weights. Downloads use Ollama; your code stays local. Only your chosen model is prepared.</p>
    <small>Download size is not RAM or VRAM usage. Memory grows with context; these estimates do not guarantee a fit.</small>
    ${catalog && !catalog.download_supported ? '<p>Automatic downloads require Ollama. Install and load local weights using your current server\'s controls.</p>' : ''}
    ${active ? '<p role="status">Another model is being prepared. Use the setup card to cancel before choosing a different model.</p>' : ''}
    ${setup?.explicit_selection && setup.state === 'ready' && setup.preference_saved === false ? `<p role="status">${escapeHtml(setup.message)}</p>` : ''}
    ${options.error ? `<p class="model-setup-error" role="alert">${escapeHtml(options.error)}</p>` : ''}
    ${options.loading ? '<p role="status">Checking the model catalog…</p>' : cards}
    ${catalog?.inventory_error ? `<p>${escapeHtml(catalog.inventory_error)}</p>` : ''}
    <button class="secondary" data-action="refreshModelCatalog" ${options.loading ? 'disabled' : ''}>Refresh models</button>
    ${catalog ? `<small>Research checked ${escapeHtml(catalog.researched_at)}. Model quality depends on the task and hardware.</small>` : ''}
  </section>`;
}
