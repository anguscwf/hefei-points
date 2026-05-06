// components/number-modal/number-modal.js
Component({
  properties: {
    show: { type: Boolean, value: false },
    title: { type: String, value: '' },
    desc: { type: String, value: '' },
    value: { type: Number, value: 0 },
    min: { type: Number, value: -999 },
    max: { type: Number, value: 999 }
  },

  data: {
    valueText: '',
    currentVal: 0,
    note: ''
  },

  observers: {
    'value': function(val) {
      this.setData({ currentVal: val });
      this.updateDisplay();
    }
  },

  methods: {
    updateDisplay: function() {
      var v = this.data.currentVal;
      this.setData({
        valueText: v > 0 ? '+' + v : '' + v
      });
    },

    onPlus: function() {
      var v = this.data.currentVal + 1;
      if (v <= (this.data.max || 999)) {
        this.setData({ currentVal: v });
        this.updateDisplay();
      }
    },

    onMinus: function() {
      var v = this.data.currentVal - 1;
      if (v >= (this.data.min || -999)) {
        this.setData({ currentVal: v });
        this.updateDisplay();
      }
    },

    onNoteInput: function(e) {
      this.setData({ note: e.detail.value });
    },

    onClose: function() {
      this.setData({ note: '' });
      this.triggerEvent('close');
    },

    onConfirm: function() {
      this.triggerEvent('confirm', {
        value: this.data.currentVal,
        note: this.data.note
      });
    }
  }
});
