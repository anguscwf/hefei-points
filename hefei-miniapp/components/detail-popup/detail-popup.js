// components/detail-popup/detail-popup.js
var app = getApp();

Component({
  properties: {
    show: { type: Boolean, value: false },
    record: {
      type: Object,
      value: { kidName: '', reason: '', amount: 0, amountText: '', operator: '', time: '', note: '' }
    }
  },

  data: {
    noteDisplay: '',
    noteDisplayClass: 'empty',
    editNote: '',
    canEdit: false
  },

  observers: {
    'record': function(rec) {
      var hasNote = rec && rec.note;
      this.setData({
        noteDisplay: hasNote ? rec.note : '暂无备注',
        noteDisplayClass: hasNote ? '' : 'empty',
        editNote: rec.note || '',
        canEdit: app.canOperate()
      });
    }
  },

  methods: {
    onClose: function() {
      this.triggerEvent('close');
    },

    onNoteInput: function(e) {
      this.setData({ editNote: e.detail.value });
    },

    onSaveNote: function() {
      this.triggerEvent('saveNote', {
        recordId: this.data.record.recordId,
        note: this.data.editNote
      });
    }
  }
});
