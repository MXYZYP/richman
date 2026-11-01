// 生产地图目录（轻量版）—— 由 scripts/generate-map-catalog.ts 生成，**不要手改**。
//
// 为什么需要它：首屏（首页）只需要「有哪些地图 + 名字 + 一句话介绍」，
// 而完整的地图包（棋盘格、卡牌、规则模块）十三张加起来 258 KB —— 首页根本用不到。
// 有了这份目录，首屏就不必加载任何地图包；玩家点进设置 / 建房 / 开局时才按需加载。
//
// 漂移防线：catalog 与真实地图包的一致性由 packages/board-data/src/__tests__/
// mapCatalog.test.ts 逐字段比对（id / version / contentHash / title / description），
// 地图一改而忘了重新生成本文件，那条测试立刻变红。

import type { MapCatalogEntry } from './mapTypes';

export interface ProductionCatalogEntry extends MapCatalogEntry {
  readonly description: string;
}

/** 与生产注册表完全一致的一份目录（顺序也一致）。 */
export const PRODUCTION_CATALOG: readonly ProductionCatalogEntry[] = [
  {
    "ref": {
      "id": "china-tour",
      "version": 1,
      "contentHash": "3d4a7126c8c44703a94e42928f6e19e0093db90a3a40a20c0dd609574df7bf69"
    },
    "title": "中国之旅",
    "description": "环游中国并经营地产的经典地图"
  },
  {
    "ref": {
      "id": "world-tour",
      "version": 1,
      "contentHash": "d87898bf70d30eb13f312c52e86f0f94513293d0cc3436809fa806fa732ec57a"
    },
    "title": "世界之旅",
    "description": "沿五十二格世界主环旅行，并从曼谷机场进入太平洋支线。"
  },
  {
    "ref": {
      "id": "classic-tour",
      "version": 1,
      "contentHash": "e98f840fc19fb4ad889b0e098e35f64d8071334e0aa7023e0060751df182cc77"
    },
    "title": "世界名城",
    "description": "环游世界名城并经营地产的精选地图"
  },
  {
    "ref": {
      "id": "silk-road",
      "version": 1,
      "contentHash": "96b01ddf1de9d42f8a2567dd0002e7b05771e1a63687f3142b4a5c1662b1060a"
    },
    "title": "丝路之旅",
    "description": "双环地图：外环走陆上丝路，中途转入内环海上丝路，再回到陆路抵达罗马。"
  },
  {
    "ref": {
      "id": "great-wall",
      "version": 1,
      "contentHash": "c7af6064562814984fc73ef71ab63748006c5b8b29a011bb35ba9e7bc95966bd"
    },
    "title": "长城之旅",
    "description": "蛇形网格棋盘：八列六段城墙蛇形排布 48 格关隘，争夺烽火台可向过路者收取通行费。"
  },
  {
    "ref": {
      "id": "yellow-river",
      "version": 1,
      "contentHash": "50e622a50d07212dc13b889a3d6734185d00bd75cae13e73e4a4304886c1a316"
    },
    "title": "黄河之旅",
    "description": "螺旋棋盘：64 格 8×8 盘旋布局，自入海口一路溯源收束到河源，越近源头地价越高，河源之后回到入海口重新启程。"
  },
  {
    "ref": {
      "id": "yangtze-tour",
      "version": 1,
      "contentHash": "ce26cddcf3ef48182a4f8a50efcea5f89360a1f2d98d37aded11e2f89e94f090"
    },
    "title": "长江之旅",
    "description": "纵向蛇行棋盘：54 格 6×9 逐列蜿蜒布局，自入海口溯流西上穿过荆楚巴蜀直达江源，越近源头地价越高，江源之后回到入海口重新启程。"
  },
  {
    "ref": {
      "id": "pearl-tour",
      "version": 1,
      "contentHash": "98e57edad6512373a8665fdca15788bc5640752605a23a89689bc54f6b3e866b"
    },
    "title": "珠江之旅",
    "description": "三角洲三角形环路：48 格沿三角三边闭合巡游，自珠江口出发沿东江北上、登顶珠江源后顺西江回落，珠江口最平、珠江源最贵。"
  },
  {
    "ref": {
      "id": "xinjiang-tour",
      "version": 1,
      "contentHash": "1805bcccc32b23cb33170c373a40a56e8cf477000d6a95536d1958def59e1b2a"
    },
    "title": "新疆之旅",
    "description": "环形棋路：40 格主环绕行天山南北，阿克苏可转入「独库公路」6 格支线，越深入腹地地价越高。"
  },
  {
    "ref": {
      "id": "shanxi-tour",
      "version": 1,
      "contentHash": "45e1ca69c36bf319c9c56f6cb0c1527606105a4b64f4811dad64cb1bd25a6659"
    },
    "title": "山西之旅",
    "description": "蛇形网格：48 格 6×8 逐层铺开，自雁门关一路南下到蒲津渡，晋南地价最高，走到太行脚下再折回起点。"
  },
  {
    "ref": {
      "id": "northeast-tour",
      "version": 1,
      "contentHash": "79597c52bd659496dfd86d561345a1c28fc0acc604855fc8d9ff36705da195b8"
    },
    "title": "东北之旅",
    "description": "蛇形网格：48 格 6×8 自沈阳北上漠河再折回大连；踩中哨卡、越界、偷渡会被关进旅顺监狱，需掷骰或耗用出狱许可证脱身。"
  },
  {
    "ref": {
      "id": "yuncheng-tour",
      "version": 1,
      "contentHash": "8d8ef3ef4821f64ea5bc15ff0da6d4fb93f94a4176f42c7953bf9d8ba8d0356f"
    },
    "title": "运城之旅",
    "description": "盐湖之畔的黄河金三角：48 格 6×8 蛇形闭环，从运城站出发经解州关帝庙、鹳雀楼一路向东南到运城盐湖，沿途票号通商、河工争水，走到盐池白土再折回起点。"
  },
  {
    "ref": {
      "id": "sanguo-tour",
      "version": 1,
      "contentHash": "52974371912680b4759e146a797a035f72b191897156fd7f5410b29750596d1d"
    },
    "title": "三国风云",
    "description": "28 格四方闭环：四角大格各据一方，每边 6 格小格。自起兵而西，过下邳、陈留、洛阳至长安，再折南入蜀经成都、井津南下襄阳，东返建业、吴地，复经招兵买马与锦囊妙计两处牌局回到起点。战场屯粮草、功德祠祈福，沿途十四座城池皆可建兵营筑城。"
  }
];
