import { Routes } from '@angular/router';
import { ChatShellComponent } from './chat-shell.component';
import { SettingsComponent } from './settings.component';

export const routes: Routes = [
  { path: '', component: ChatShellComponent },
  { path: 'settings', component: SettingsComponent },
];
