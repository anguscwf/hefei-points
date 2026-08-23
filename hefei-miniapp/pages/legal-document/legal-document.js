var app = getApp();
var viewModel = require('../../utils/guardian-page.js');

var DOCUMENTS = {
  privacyPolicy: '隐私政策',
  childPersonalInformationRules: '儿童个人信息保护规则',
  childUserAgreement: '儿童用户协议',
  sensitiveInformationNotice: '敏感个人信息单独告知',
  guardianRelationDeclaration: '监护关系声明'
};

function safePublicUrl(value) {
  if (typeof value !== 'string' || !/^https:\/\/[^\s]{1,2038}$/.test(value)) return '';
  var authority = value.slice('https://'.length).split(/[/?#]/)[0];
  if (!authority || authority.indexOf('@') >= 0) return '';
  return value;
}

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
      var url = safePublicUrl(document && document.publicUrl);
      if (!url) {
        that.setData({ loading: false, errorText: '公开文本地址尚未安全配置' });
        return;
      }
      that.setData({ loading: false, publicUrl: url });
    });
  }
});
