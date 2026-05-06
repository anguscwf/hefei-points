// components/action-sheet/action-sheet.js
Component({
  properties: {
    show: { type: Boolean, value: false },
    kidName: { type: String, value: '' },
    kidPoints: { type: Number, value: 0 },
    rewardRules: { type: Array, value: [] },
    punishRules: { type: Array, value: [] }
  },

  data: {
    manualAmt: '',
    manualReason: ''
  },

  methods: {
    onClose: function() {
      this.triggerEvent('close');
    },

    onSelectRule: function(e) {
      this.triggerEvent('select', e.currentTarget.dataset.item);
    },

    onAmtInput: function(e) {
      this.setData({ manualAmt: e.detail.value });
    },

    onReasonInput: function(e) {
      this.setData({ manualReason: e.detail.value });
    },

    onManualConfirm: function() {
      var amt = parseInt(this.data.manualAmt);
      if (isNaN(amt) || amt === 0) {
        wx.showToast({ title: '请输入有效分数', icon: 'none' });
        return;
      }
      this.triggerEvent('manual', {
        amount: amt,
        reason: this.data.manualReason || '手动',
        note: ''
      });
      this.setData({ manualAmt: '', manualReason: '' });
    }
  }
});
