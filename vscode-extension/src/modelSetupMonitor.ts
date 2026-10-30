import type { ModelSetupStatus } from './backendClient';

export const setupActive = (state: ModelSetupStatus['state']): boolean =>
  ['checking', 'downloading', 'loading'].includes(state);

/** One shared setup job lives on the backend; this view only observes it. */
export class ModelSetupMonitor {
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly backend: {
      getModelSetup(): Promise<ModelSetupStatus>;
      startModelSetup(): Promise<ModelSetupStatus>;
      cancelModelSetup(): Promise<ModelSetupStatus>;
    },
    private readonly update: (status: ModelSetupStatus) => Promise<void>,
    private readonly failure: (error: Error) => Promise<void>,
  ) {}

  public stop(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  public async refresh(action: 'check' | 'start' | 'cancel' = 'check'): Promise<void> {
    this.stop();
    await this.poll(this.generation, action);
  }

  private async poll(generation: number, action: 'check' | 'start' | 'cancel'): Promise<void> {
    try {
      let status = action === 'start' ? await this.backend.startModelSetup()
        : action === 'cancel' ? await this.backend.cancelModelSetup() : await this.backend.getModelSetup();
      if (generation !== this.generation) return;
      if (action === 'check' && status.state === 'idle' && status.auto_setup_enabled) {
        status = await this.backend.startModelSetup();
      }
      if (generation !== this.generation) return;
      await this.update(status);
      if (generation === this.generation && (setupActive(status.state) || !status.can_retry || status.state === 'ready')) {
        this.timer = setTimeout(() => { void this.poll(generation, 'check'); }, status.state === 'ready' ? 30000 : 1000);
      }
    } catch (error) {
      if (generation === this.generation) {
        await this.failure(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}
