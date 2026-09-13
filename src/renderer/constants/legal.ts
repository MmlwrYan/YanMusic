export interface LegalSection {
  title: string;
  content: string;
}

export const USER_AGREEMENT_SECTIONS: LegalSection[] = [
  {
    title: '1. 项目性质',
    content: '本程序是酷狗音乐第三方客户端，非官方产品。如需完整功能体验，请使用官方客户端。',
  },
  {
    title: '2. 使用范围',
    content:
      '本项目仅供个人学习和技术研究使用。您不得将本项目用于任何商业用途或违反法律法规的行为。',
  },
  {
    title: '3. 版权内容',
    content:
      '本项目通过公开接口获取音乐数据，不存储任何音频文件。所有音乐内容版权归原平台及版权方所有。使用过程中产生的缓存数据应在 24 小时内清除。',
  },
  {
    title: '4. 免责条款',
    content:
      '开发者不对因使用本项目导致的任何直接或间接损失承担责任，包括但不限于数据丢失、设备故障、法律纠纷等。',
  },
  {
    title: '5. 法律责任',
    content: '您应遵守所在地区的法律法规使用本项目。因违法使用导致的一切法律后果由使用者自行承担。',
  },
  {
    title: '6. 版权尊重',
    content:
      '请尊重音乐创作者和平台的劳动成果，支持正版音乐。本项目不接受任何商业合作、广告或捐赠。',
  },
  {
    title: '7. 争议处理',
    content: '如版权方对本项目有异议，请通过 GitHub Issues 联系开发者，我们将及时处理。',
  },
];

export const USER_AGREEMENT_FOOTER = '点击“同意并继续”即表示您已阅读并接受以上全部条款。';

export const DISCLAIMER_SECTIONS: LegalSection[] = [
  {
    title: '致谢',
    content:
      '本软件基于 GitHub 上著名项目 EchoMusic（本项目参考的上游版本：2.3.1-beta.24；作者：hoowhoami）二次开发，在此向 hoowhoami 及所有参与 EchoMusic 开发的开发者致以诚挚敬意。原始版权归 EchoMusic 项目及其开发者所有，本项目中沿用自上游的代码与资源的版权仍归原作者，本项目依据 GNU General Public License v3.0 的条款使用与再发布。本项目在上游版本基础上进行的修改包括：适配 libmpv 播放引擎与一体化打包、调整界面文案与品牌标识（YanMusic）、修复若干 bug（含恢复直接领取 VIP 的功能）；本项目修改部分与上游原始内容的差异说明见仓库内的 CHANGELOG.md 与各版本发行说明。EchoMusic 项目基于 GNU General Public License v3.0 协议开源，该协议允许对软件进行修改、研究和重新发布。感谢 EchoMusic 团队为社区做出的杰出贡献！',
  },
  {
    title: '项目定位',
    content:
      '本项目是基于公开接口开发的第三方音乐客户端，仅用于技术学习和研究，不涉及任何商业行为。',
  },
  {
    title: '数据来源',
    content:
      '所有音乐数据均通过公开 API 接口获取，本项目不存储、不传播任何音频文件。音乐内容版权归原平台及版权方所有。',
  },
  {
    title: '使用限制',
    content:
      '本项目仅供个人学习使用，禁止用于商业用途或违法行为。使用者应遵守当地法律法规，尊重知识产权。',
  },
  {
    title: '责任声明',
    content:
      '因使用本项目产生的任何直接或间接损失，包括但不限于法律纠纷、数据丢失、设备故障等，均由使用者自行承担。',
  },
  {
    title: '版权尊重',
    content: '音乐创作不易，请支持正版。建议仅将本项目用于试听，如需长期使用请购买官方会员服务。',
  },
  {
    title: '开源协议',
    content:
      '本项目遵循 GNU General Public License v3.0（GPL-3.0）协议开源发布，该协议允许对软件进行修改、研究和重新发布；完整许可证文本见随安装包分发的 LICENSE 文件，或本仓库根目录的 LICENSE。本项目的修改版本亦遵循此精神，开源共享。',
  },
  {
    title: '争议解决',
    content: '如版权方认为本项目侵犯其权益，请通过 GitHub Issues 联系，我们将积极配合处理。',
  },
];
