import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { ModelSetupStatus } from './models';

@Component({
  selector: 'app-model-setup',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './model-setup.component.html',
  styleUrl: './model-setup.component.scss',
})
export class ModelSetupComponent {
  @Input() status: ModelSetupStatus | null = null;
  @Input() busy = false;
  @Input() requestPending = false;
  @Input() canCancel = false;
  @Input() error = '';
  @Output() retry = new EventEmitter<void>();
  @Output() cancel = new EventEmitter<void>();
  @Output() reconnect = new EventEmitter<void>();

  get title(): string {
    if (!this.status) return this.error ? 'Let’s connect CodeMe' : 'Getting your local model ready';
    return {
      idle: 'Set up your local coding model', checking: 'Checking your local model',
      runtime_missing: 'One small step before you start', server_unavailable: 'Your model server needs attention',
      downloading: 'Downloading your coding model', loading: 'Starting your coding model',
      ready: 'Your local model is ready', error: 'Model setup needs a retry', cancelled: 'Model setup paused',
    }[this.status.state];
  }

  get percent(): number | null {
    const percent = this.status?.percent;
    return typeof percent === 'number' && Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
  }

  formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return (bytes / 1024 ** index).toFixed(index ? 1 : 0) + ' ' + units[index];
  }
}
