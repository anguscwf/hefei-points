/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { AbilityConstant, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    try {
      this.context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT);
    } catch (_) {
      // Color mode is cosmetic. Platform errors are intentionally not serialized into logs.
    }
    AppStorage.setOrCreate<boolean>('tangguanAppForeground', false);
  }

  onDestroy(): void {
    AppStorage.set<boolean>('tangguanAppForeground', false);
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (error) => {
      if (error.code) {
        return;
      }
    });
  }

  onWindowStageDestroy(): void {
    AppStorage.set<boolean>('tangguanAppForeground', false);
  }

  onForeground(): void {
    AppStorage.set<boolean>('tangguanAppForeground', true);
  }

  onBackground(): void {
    AppStorage.set<boolean>('tangguanAppForeground', false);
  }
}
