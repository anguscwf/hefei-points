var ICON_BOUNDS = {
  brand: [68, 49, 236, 270],
  family: [317, 84, 482, 258],
  'kid-a': [565, 95, 723, 258],
  'kid-b': [800, 85, 968, 250],
  person: [1044, 96, 1200, 253],
  'jar-blue': [81, 328, 224, 509],
  'jar-pink': [316, 328, 459, 509],
  'family-heart': [548, 348, 714, 500],
  trophy: [800, 335, 958, 488],
  'medal-1': [1061, 336, 1175, 490],
  'medal-2': [93, 563, 206, 717],
  'medal-3': [327, 563, 440, 717],
  camera: [547, 576, 707, 720],
  palette: [788, 571, 955, 728],
  clipboard: [1044, 559, 1178, 723],
  'trend-up': [74, 802, 221, 944],
  'trend-down': [317, 801, 466, 944],
  settings: [548, 800, 704, 954],
  warning: [794, 805, 943, 945],
  edit: [1034, 811, 1179, 946],
  spark: [68, 1022, 205, 1169],
  share: [300, 1028, 444, 1181],
  save: [551, 1028, 690, 1179],
  refresh: [790, 1031, 931, 1179],
  clean: [1028, 1024, 1161, 1183]
};

var ATLAS_SOURCE_SIZE = 1254;

var ATLAS_PATHS = {
  mint: '/images/ui-icons-mint-v5.png',
  amber: '/images/ui-icons-amber-v5.png',
  white: '/images/ui-icons-white-v5.png'
};

Component({
  properties: {
    name: { type: String, value: 'brand' },
    size: { type: Number, value: 44 },
    theme: { type: String, value: '' },
    variant: { type: String, value: '' },
    color: { type: String, value: '' },
    rank: { type: Number, value: 1 }
  },

  data: {
    atlasPath: ATLAS_PATHS.mint,
    atlasSize: 220,
    offsetX: 0,
    offsetY: 0
  },

  observers: {
    'name,size,theme,variant,color,rank': function() {
      this._syncSprite();
    }
  },

  lifetimes: {
    attached: function() {
      this._syncSprite();
    }
  },

  methods: {
    _syncSprite: function() {
      var name = this.data.name;
      var rank = Math.max(1, Math.min(3, Number(this.data.rank) || 1));
      var key = name === 'medal' ? 'medal-' + rank : name;
      if (key === 'jar') key = 'brand';

      var bounds = ICON_BOUNDS[key] || ICON_BOUNDS.brand;
      var size = Math.max(16, Number(this.data.size) || 44);
      var sourceWidth = bounds[2] - bounds[0];
      var sourceHeight = bounds[3] - bounds[1];
      var sourceCenterX = (bounds[0] + bounds[2]) / 2;
      var sourceCenterY = (bounds[1] + bounds[3]) / 2;
      var fillRatio = key === 'brand' || key === 'jar-blue' || key === 'jar-pink' ? 0.9 : 0.84;
      var sourceScale = size * fillRatio / Math.max(sourceWidth, sourceHeight);

      var variant = String(this.data.variant || '').toLowerCase();
      var color = String(this.data.color || '').toLowerCase().replace(/\s/g, '');
      var theme = String(this.data.theme || '').toLowerCase();
      if (!theme) {
        var app = getApp();
        theme = app && app.globalData && app.globalData.theme === 'amber' ? 'amber' : 'mint';
      }
      if (variant !== 'white' && variant !== 'amber' && variant !== 'mint') {
        variant = color === '#ffffff' || color === 'white' ? 'white' : (theme === 'amber' ? 'amber' : 'mint');
      }

      // Generated atlas cells are not geometrically uniform. Position every glyph
      // from its real alpha bounds so the visible artwork, not the cell, is centered.
      this.setData({
        atlasPath: ATLAS_PATHS[variant],
        atlasSize: ATLAS_SOURCE_SIZE * sourceScale,
        offsetX: size / 2 - sourceCenterX * sourceScale,
        offsetY: size / 2 - sourceCenterY * sourceScale
      });
    }
  }
});
