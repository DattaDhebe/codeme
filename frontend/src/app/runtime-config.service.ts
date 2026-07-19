import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Inject, Injectable, PLATFORM_ID } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface RuntimeConfig {
  backendUrl: string;
  defaultModel: string;
  allowRemoteBackend: boolean;
}

const DEFAULT_CONFIG: RuntimeConfig = {
  backendUrl: 'http://127.0.0.1:8000',
  defaultModel: 'qwen2.5-coder:7b',
  allowRemoteBackend: false,
};

@Injectable({ providedIn: 'root' })
export class RuntimeConfigService {
  private value: RuntimeConfig = { ...DEFAULT_CONFIG };

  constructor(
    private readonly http: HttpClient,
    @Inject(PLATFORM_ID) private readonly platformId: object,
  ) {}

  get backendUrl(): string {
    return this.value.backendUrl;
  }

  get apiBaseUrl(): string {
    return `${this.backendUrl}/api`;
  }

  get defaultModel(): string {
    return this.value.defaultModel;
  }

  get isBrowser(): boolean {
    return isPlatformBrowser(this.platformId);
  }

  async load(): Promise<void> {
    if (!this.isBrowser) {
      return;
    }
    try {
      const loaded = await firstValueFrom(this.http.get<Partial<RuntimeConfig>>('/runtime-config.json'));
      const allowRemoteBackend = loaded.allowRemoteBackend === true;
      this.value = {
        backendUrl: this.validateBackendUrl(loaded.backendUrl || DEFAULT_CONFIG.backendUrl, allowRemoteBackend),
        defaultModel: this.validateModel(loaded.defaultModel),
        allowRemoteBackend,
      };
    } catch (error) {
      console.warn('Personal Codex runtime configuration was rejected; safe local defaults are active.', error);
      this.value = { ...DEFAULT_CONFIG };
    }
  }

  private validateBackendUrl(rawUrl: string, allowRemoteBackend: boolean): string {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('The backend URL must be an HTTP(S) URL without embedded credentials.');
    }
    const hostname = parsed.hostname.toLowerCase();
    const isLocal = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
    if (!isLocal && !allowRemoteBackend) {
      throw new Error('Non-local backends require allowRemoteBackend=true.');
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  }

  private validateModel(model: string | undefined): string {
    const normalized = model?.trim();
    return normalized && normalized.length <= 200 ? normalized : DEFAULT_CONFIG.defaultModel;
  }
}
