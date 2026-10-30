import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CodingModel, ModelCatalog, ModelSetupStatus } from './models';

@Component({
  selector: 'app-model-catalog',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './model-catalog.component.html',
  styleUrl: './model-catalog.component.scss',
})
export class ModelCatalogComponent {
  @Input() catalog: ModelCatalog | null = null;
  @Input() status: ModelSetupStatus | null = null;
  @Input() loading = false;
  @Input() busy = false;
  @Input() streaming = false;
  @Input() currentModel = '';
  @Input() provider: 'ollama' | 'openai_compatible' = 'ollama';
  @Input() error = '';
  @Output() selectModel = new EventEmitter<CodingModel>();
  @Output() refresh = new EventEmitter<void>();
  @Output() close = new EventEmitter<void>();

  get setupActive(): boolean { return this.busy || !!this.catalog?.setup_active; }
  get downloadSupported(): boolean { return this.provider === 'ollama' && !!this.catalog?.download_supported; }

  canSelect(model: CodingModel): boolean {
    return this.downloadSupported && !this.setupActive && !this.streaming
      && !this.isInUse(model);
  }

  select(model: CodingModel): void {
    if (this.canSelect(model)) this.selectModel.emit(model);
  }

  actionLabel(model: CodingModel): string {
    if (this.setupActive && this.status?.catalog_id === model.id) return 'Preparing this model';
    if (this.isInUse(model)) return 'In use';
    return model.installed === true ? 'Use installed model' : model.installed === false ? 'Download and use' : 'Check and set up';
  }

  isInUse(model: CodingModel): boolean {
    return this.status?.state === 'ready' && (this.currentModel === model.ollama_model
      || model.active && this.currentModel === this.status.model);
  }

  sourceLink(url: string, host: 'huggingface.co' | 'ollama.com'): string | null {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && parsed.hostname === host && (!parsed.port || parsed.port === '443') && !parsed.username && !parsed.password ? parsed.href : null;
    } catch { return null; }
  }
}
