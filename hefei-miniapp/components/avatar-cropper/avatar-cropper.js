Component({
  properties: {
    show: { type: Boolean, value: false },
    src: { type: String, value: '' },
    accent: { type: String, value: '#2D9B7A' }
  },

  data: {
    shape: 'circle',
    ready: false,
    stageSize: 0,
    stageLeft: 0,
    stageTop: 0,
    sourceWidth: 0,
    sourceHeight: 0,
    baseWidth: 0,
    baseHeight: 0,
    imageWidth: 0,
    imageHeight: 0,
    imageX: 0,
    imageY: 0,
    scale: 1,
    zoomValue: 100,
    applying: false
  },

  observers: {
    'show, src': function(show, src) {
      var that = this;
      if (!show || !src) return;
      wx.nextTick(function() { that.initCropper(src); });
    }
  },

  methods: {
    initCropper: function(src) {
      var that = this;
      this.setData({ ready: false, applying: false, scale: 1, zoomValue: 100 });
      Promise.all([
        new Promise(function(resolve, reject) {
          wx.getImageInfo({ src: src, success: resolve, fail: reject });
        }),
        new Promise(function(resolve, reject) {
          that.createSelectorQuery().select('.crop-stage').boundingClientRect(function(rect) {
            if (rect && rect.width) resolve(rect);
            else reject(new Error('crop stage unavailable'));
          }).exec();
        })
      ]).then(function(results) {
        var info = results[0];
        var rect = results[1];
        var size = rect.width;
        var coverScale = Math.max(size / info.width, size / info.height);
        var width = info.width * coverScale;
        var height = info.height * coverScale;
        that.setData({
          ready: true,
          stageSize: size,
          stageLeft: rect.left,
          stageTop: rect.top,
          sourceWidth: info.width,
          sourceHeight: info.height,
          baseWidth: width,
          baseHeight: height,
          imageWidth: width,
          imageHeight: height,
          imageX: (size - width) / 2,
          imageY: (size - height) / 2
        });
      }).catch(function() {
        wx.showToast({ title: '图片读取失败，请重试', icon: 'none' });
        that.triggerEvent('cancel');
      });
    },

    setShape: function(e) {
      this.setData({ shape: e.currentTarget.dataset.shape === 'square' ? 'square' : 'circle' });
    },

    getPoint: function(touch) {
      return {
        x: touch.clientX - this.data.stageLeft,
        y: touch.clientY - this.data.stageTop
      };
    },

    getDistance: function(a, b) {
      var dx = a.x - b.x;
      var dy = a.y - b.y;
      return Math.sqrt(dx * dx + dy * dy);
    },

    clampPosition: function(x, y, width, height) {
      var size = this.data.stageSize;
      return {
        x: Math.min(0, Math.max(size - width, x)),
        y: Math.min(0, Math.max(size - height, y))
      };
    },

    onTouchStart: function(e) {
      if (!this.data.ready) return;
      var touches = e.touches || [];
      if (touches.length >= 2) {
        var a = this.getPoint(touches[0]);
        var b = this.getPoint(touches[1]);
        this._gesture = {
          type: 'pinch',
          distance: this.getDistance(a, b),
          scale: this.data.scale,
          width: this.data.imageWidth,
          height: this.data.imageHeight,
          x: this.data.imageX,
          y: this.data.imageY,
          centerX: (a.x + b.x) / 2,
          centerY: (a.y + b.y) / 2
        };
      } else if (touches.length === 1) {
        var point = this.getPoint(touches[0]);
        this._gesture = { type: 'drag', x: point.x, y: point.y };
      }
    },

    onTouchMove: function(e) {
      if (!this._gesture || !this.data.ready) return;
      var touches = e.touches || [];
      if (touches.length >= 2 && this._gesture.type === 'pinch') {
        var a = this.getPoint(touches[0]);
        var b = this.getPoint(touches[1]);
        var ratio = this.getDistance(a, b) / Math.max(1, this._gesture.distance);
        var scale = Math.max(1, Math.min(4, this._gesture.scale * ratio));
        var scaleRatio = scale / this._gesture.scale;
        var width = this._gesture.width * scaleRatio;
        var height = this._gesture.height * scaleRatio;
        var x = this._gesture.centerX - (this._gesture.centerX - this._gesture.x) * scaleRatio;
        var y = this._gesture.centerY - (this._gesture.centerY - this._gesture.y) * scaleRatio;
        var position = this.clampPosition(x, y, width, height);
        this.setData({
          scale: scale,
          zoomValue: Math.round(scale * 100),
          imageWidth: width,
          imageHeight: height,
          imageX: position.x,
          imageY: position.y
        });
      } else if (touches.length === 1) {
        var point = this.getPoint(touches[0]);
        if (this._gesture.type !== 'drag') {
          this._gesture = { type: 'drag', x: point.x, y: point.y };
          return;
        }
        var nextX = this.data.imageX + point.x - this._gesture.x;
        var nextY = this.data.imageY + point.y - this._gesture.y;
        var clamped = this.clampPosition(nextX, nextY, this.data.imageWidth, this.data.imageHeight);
        this._gesture.x = point.x;
        this._gesture.y = point.y;
        this.setData({ imageX: clamped.x, imageY: clamped.y });
      }
    },

    onTouchEnd: function(e) {
      var touches = e.touches || [];
      if (touches.length === 1) {
        var point = this.getPoint(touches[0]);
        this._gesture = { type: 'drag', x: point.x, y: point.y };
      } else {
        this._gesture = null;
      }
    },

    onZoom: function(e) {
      if (!this.data.ready) return;
      var scale = Math.max(1, Math.min(4, Number(e.detail.value) / 100));
      var width = this.data.baseWidth * scale;
      var height = this.data.baseHeight * scale;
      var size = this.data.stageSize;
      var centerX = size / 2;
      var centerY = size / 2;
      var x = centerX - (centerX - this.data.imageX) * (width / this.data.imageWidth);
      var y = centerY - (centerY - this.data.imageY) * (height / this.data.imageHeight);
      var position = this.clampPosition(x, y, width, height);
      this.setData({
        scale: scale,
        zoomValue: Math.round(scale * 100),
        imageWidth: width,
        imageHeight: height,
        imageX: position.x,
        imageY: position.y
      });
    },

    cancel: function() {
      if (!this.data.applying) this.triggerEvent('cancel');
    },

    stopBubble: function() {},

    apply: function() {
      var that = this;
      if (!this.data.ready || this.data.applying) return;
      this.setData({ applying: true });
      this.createSelectorQuery().select('#avatarCropCanvas').fields({ node: true, size: true }).exec(function(result) {
        var field = result && result[0];
        if (!field || !field.node) {
          that.handleApplyError();
          return;
        }
        var canvas = field.node;
        var outputSize = 512;
        canvas.width = outputSize;
        canvas.height = outputSize;
        var context = canvas.getContext('2d');
        var image = canvas.createImage();
        image.onload = function() {
          var d = that.data;
          var sourceX = -d.imageX / d.imageWidth * d.sourceWidth;
          var sourceY = -d.imageY / d.imageHeight * d.sourceHeight;
          var sourceW = d.stageSize / d.imageWidth * d.sourceWidth;
          var sourceH = d.stageSize / d.imageHeight * d.sourceHeight;
          context.clearRect(0, 0, outputSize, outputSize);
          context.save();
          if (d.shape === 'circle') {
            context.beginPath();
            context.arc(outputSize / 2, outputSize / 2, outputSize / 2, 0, Math.PI * 2);
            context.clip();
          }
          context.drawImage(image, sourceX, sourceY, sourceW, sourceH, 0, 0, outputSize, outputSize);
          context.restore();
          wx.canvasToTempFilePath({
            canvas: canvas,
            fileType: 'png',
            quality: 0.92,
            destWidth: outputSize,
            destHeight: outputSize,
            success: function(res) {
              that.setData({ applying: false });
              that.triggerEvent('apply', { filePath: res.tempFilePath, shape: d.shape });
            },
            fail: function() { that.handleApplyError(); }
          }, that);
        };
        image.onerror = function() { that.handleApplyError(); };
        image.src = that.properties.src;
      });
    },

    handleApplyError: function() {
      this.setData({ applying: false });
      wx.showToast({ title: '裁剪失败，请重试', icon: 'none' });
    }
  }
});
