// components/action-sheet/action-sheet.js
Component({
  properties: {
    show: { type: Boolean, value: false },
    kidName: { type: String, value: '' },
    kidPoints: { type: Number, value: 0 },
    theme: { type: String, value: 'mint' },
    rewardRules: { type: Array, value: [] },
    punishRules: { type: Array, value: [] }
  },

  data: {
    manualAmt: '',
    manualReason: '',
    manualSign: 1
  },

  methods: {
    noop: function() {
    },

    onClose: function() {
      this.setData({ manualAmt: '', manualReason: '', manualSign: 1 });
      this.triggerEvent('close');
    },

    onSelectRule: function(e) {
      if (this._longRuleTriggered) {
        this._longRuleTriggered = false;
        return;
      }
      this.triggerEvent('quick', e.currentTarget.dataset.item);
    },

    onAdjustRule: function(e) {
      var that = this;
      this._longRuleTriggered = true;
      clearTimeout(this._longRuleTimer);
      this._longRuleTimer = setTimeout(function() {
        that._longRuleTriggered = false;
      }, 800);
      this.triggerEvent('adjust', e.currentTarget.dataset.item);
    },

    onAmtInput: function(e) {
      this.setData({ manualAmt: e.detail.value });
    },

    onManualSignChange: function(e) {
      var sign = Number(e.currentTarget.dataset.sign) === -1 ? -1 : 1;
      this.setData({ manualSign: sign });
    },

    onReasonInput: function(e) {
      this.setData({ manualReason: e.detail.value });
    },

    onManualConfirm: function() {
      var raw = String(this.data.manualAmt || '').trim();
      var absAmt = Math.abs(Number(raw));
      var sign = this.data.manualSign === -1 ? -1 : 1;
      var amt = absAmt * sign;
      var reason = String(this.data.manualReason || '').trim();
      if (!raw || !Number.isInteger(absAmt) || absAmt === 0) {
        wx.showToast({ title: '请输入有效分数', icon: 'none' });
        return;
      }
      var maxAbs = sign === -1 ? 500 : 1000;
      if (absAmt > maxAbs) {
        wx.showToast({ title: sign === -1 ? '扣分不能超过500分' : '加分不能超过1000分', icon: 'none' });
        return;
      }
      if (reason.length > 50) {
        wx.showToast({ title: '事由不能超过50字', icon: 'none' });
        return;
      }
      this.triggerEvent('manual', {
        amount: amt,
        reason: reason || (sign === -1 ? '手动扣分' : '手动加分'),
        note: ''
      });
      this.setData({ manualAmt: '', manualReason: '', manualSign: 1 });
    }
  }
});
