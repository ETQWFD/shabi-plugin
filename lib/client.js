/**
 * lib/client.js — DSH Web 设置页客户端半边。
 *
 * 注册一个官方 settings.section，把 /shabi/settings 作为内嵌页面放进
 * DSH 设置导航；这样用户不需要记端口，也不需要打开独立 dev-server。
 * 该文件是 DSH 模块加载器格式（window.__ModuleLoader__），不是 ESM。
 */
window.__ModuleLoader__.load({
  id: 'shabi-plugin',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const inject = ['slots'];

    function ShabiSettingsSection() {
      return React.createElement('iframe', {
        src: '/shabi/settings',
        title: '沙币设置',
        style: {
          width: '100%',
          minHeight: '72vh',
          height: '100%',
          border: '0',
          background: 'transparent',
          display: 'block',
        },
      });
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'shabi',
        order: 80,
        label: () => '沙币',
      }, ShabiSettingsSection));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
