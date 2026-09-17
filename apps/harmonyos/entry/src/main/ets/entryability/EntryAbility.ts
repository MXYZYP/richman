import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';

const DOMAIN: number = 0x0000;
const TAG: string = 'RichmanEntry';

/**
 * 入口 Ability：仅负责把 pages/Index 加载到窗口。
 * 真正的游戏逻辑在 Web 组件里跑（与 Android Capacitor 同理——网页即 App）。
 */
export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onCreate');
  }

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onWindowStageCreate');

    // 让 WebView 能铺满全屏并适配挖孔/灵动岛等安全区域
    windowStage.getMainWindow().then((win) => {
      win.setWindowLayoutFullScreen(true).catch((e: Error) => {
        hilog.error(DOMAIN, TAG, 'setFullScreen failed: %{public}s', JSON.stringify(e));
      });
    }).catch((e: Error) => {
      hilog.error(DOMAIN, TAG, 'getMainWindow failed: %{public}s', JSON.stringify(e));
    });

    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, 'Failed to load the content. Cause: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, TAG, '%{public}s', 'Content loaded');
    });
  }

  onWindowStageDestroy(): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onWindowStageDestroy');
  }

  onForeground(): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onForeground');
  }

  onBackground(): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onBackground');
  }
}
