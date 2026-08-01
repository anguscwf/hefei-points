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
    },
    'show': function(show) {
      if (show) {
        this.setData({ currentVal: this.data.value, note: '' });
        this.updateDisplay();
      } else {
        this.stopLongPress();
      }
    }
  },

  lifetimes: {
    detached: function() {
      this.stopLongPress();
    }
  },

  methods: {
    updateDisplay: function() {
      var v = this.data.currentVal;
      this.setData({
        valueText: v > 0 ? '+' + v : '' + v
      });
    },

    changeBy: function(step) {
      var v = this.data.currentVal + step;
      if (v > this.data.max) v = this.data.max;
      if (v < this.data.min) v = this.data.min;
      if (v === this.data.currentVal) return;
      this.setData({ currentVal: v });
      this.updateDisplay();
      this.triggerEvent('change', { value: v });
    },

    onPlus: function() {
      if (this.consumeLongPressTap()) return;
      this.changeBy(1);
    },

    onMinus: function() {
      if (this.consumeLongPressTap()) return;
      this.changeBy(-1);
    },

    startLongPress: function(step) {
      var that = this;
      this.stopLongPress();
      this._longPressTriggered = false;
      this._longPressTimer = setTimeout(function() {
        that._longPressTriggered = true;
        that.changeBy(step * 10);
        that._longPressInterval = setInterval(function() {
          that.changeBy(step * 10);
        }, 90);
      }, 420);
    },

    onLongPlusStart: function() {
      this.startLongPress(1);
    },

    onLongMinusStart: function() {
      this.startLongPress(-1);
    },

    onLongEnd: function() {
      this.stopLongPress(true);
    },

    stopLongPress: function(preserveTapGuard) {
      clearTimeout(this._longPressTimer);
      clearInterval(this._longPressInterval);
      this._longPressTimer = null;
      this._longPressInterval = null;
      if (!preserveTapGuard) this._longPressTriggered = false;
    },

    consumeLongPressTap: function() {
      if (!this._longPressTriggered) return false;
      this._longPressTriggered = false;
      return true;
    },

    noop: function() {
    },

    onNoteInput: function(e) {
      this.setData({ note: e.detail.value });
    },

    onClose: function() {
      this.stopLongPress();
      this.setData({ note: '' });
      this.triggerEvent('close');
    },

    onConfirm: function() {
      this.stopLongPress();
      this.triggerEvent('confirm', {
        value: this.data.currentVal,
        note: this.data.note
      });
    }
  }
});
