var app = getApp();
var viewModel = require('../../utils/guardian-page.js');
var legalPublicUrl = require('../../utils/legal-public-url.js');

var DOCUMENTS = {
  privacyPolicy: '隐私政策',
  childPersonalInformationRules: '儿童个人信息保护规则',
  childUserAgreement: '儿童用户协议',
  sensitiveInformationNotice: '敏感个人信息单独告知',
  guardianRelationDeclaration: '监护关系声明'
};

Page({
  data: {
    themePageStyle: '',
    themeClass: '',
    title: '公开法律文本',
    loading: true,
    errorText: '',
    publicUrl: ''
  },

  onLoad: function(options) {
    var type = options && options.type;
    if (!Object.prototype.hasOwnProperty.call(DOCUMENTS, type)) type = '';
    this._documentType = type;
    this._alive = true;
    this.setData({
      themePageStyle: app.getThemePageStyle(),
      themeClass: app.globalData.theme === 'mint' ? 'theme-mint' : '',
      title: DOCUMENTS[type] || '公开法律文本'
    });
    wx.setNavigationBarTitle({ title: DOCUMENTS[type] || '公开法律文本' });
    this.loadDocument();
  },

  onUnload: function() {
    this._alive = false;
    this.data.publicUrl = '';
  },

  loadDocument: function() {
    var that = this;
    if (!this._documentType) {
      this.setData({ loading: false, errorText: '文本类型无效' });
      return;
    }
    this.setData({ loading: true, errorText: '', publicUrl: '' });
    app.guardianApi.currentLegalTexts().then(function(result) {
      if (!that._alive) return;
      if (!result.ok) {
        that.setData({ loading: false, errorText: viewModel.errorMessage(result, '公开文本加载失败') });
        return;
      }
      var body = result.data || {};
      var document = that._documentType === 'guardianRelationDeclaration'
        ? body.guardianRelationDeclaration
        : body.texts && body.texts[that._documentType];
      var environment = typeof app.getRuntimeEnvironment === 'function'
        ? app.getRuntimeEnvironment() : null;
      var url = legalPublicUrl.safePublicUrl(document && document.publicUrl, environment, {
        type: that._documentType,
        version: document && document.version,
        sha256: document && document.sha256
      });
      if (!url) {
        that.setData({ loading: false, errorText: '公开文本地址尚未安全配置' });
        return;
      }
      that.setData({ loading: false, publicUrl: url });
    });
  },

  onWebViewError: function() {
    if (!this._alive) return;
    this.setData({
      loading: false,
      publicUrl: '',
      errorText: '公开文本打开失败，请稍后重新加载'
    });
  }
});
