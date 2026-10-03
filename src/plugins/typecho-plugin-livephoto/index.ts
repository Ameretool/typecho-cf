import type { PluginInitContext } from 'typecho/plugin-sdk';
import { loadPluginConfig } from 'typecho/plugin-sdk';

export default function init({ addHook, pluginId }: PluginInitContext): void {
  // ========== 前台注入 ==========
  addHook('archive:footer', pluginId, (html: string, extra?: { options?: Record<string, unknown> }) => {
    // 读取插件配置
    const config = loadPluginConfig(extra?.options ?? {}, pluginId);

    const lightboxSelector = config.lightboxSelector || '.lightbox-img';
    const livePhotoSelector = config.livePhotoSelector || '.live-photo';
    const enableLightbox = config.enableLightbox !== '0';
    const enableLivePhoto = config.enableLivePhoto !== '0';

    const script = `
<script is:inline src="/js/live.js"></script>
<script>
(function() {
  var lightboxSelector = ${JSON.stringify(lightboxSelector)};
  var livePhotoSelector = ${JSON.stringify(livePhotoSelector)};
  var enableLightbox = ${enableLightbox};
  var enableLivePhoto = ${enableLivePhoto};

  // ----- 保存实例引用，用于清理 -----
  var livePhotoInstances = [];
  var lightboxDestroyFn = null;

  function initialize() {
    // 清理旧的 LivePhoto
    if (livePhotoInstances.length > 0) {
      livePhotoInstances.forEach(function(inst) {
        if (inst && typeof inst.destroy === 'function') inst.destroy();
      });
      livePhotoInstances = [];
    }

    // 清理旧的 Lightbox 监听器
    if (lightboxDestroyFn) {
      lightboxDestroyFn();
      lightboxDestroyFn = null;
    }

    // 关闭还开着的灯箱
    if (typeof Lightbox !== 'undefined' && typeof Lightbox.close === 'function') {
      Lightbox.close();
    }

    // 重新初始化
    if (enableLivePhoto && typeof LivePhoto !== 'undefined') {
      var instances = LivePhoto.init(livePhotoSelector);
      if (Array.isArray(instances)) {
        livePhotoInstances = instances;
      }
    }

    if (enableLightbox && typeof Lightbox !== 'undefined') {
      // Lightbox.init 返回销毁函数
      lightboxDestroyFn = Lightbox.init(lightboxSelector);
    }
  }

  // 首次加载
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function onReady() {
      initialize();
      document.removeEventListener('DOMContentLoaded', onReady);
    });
  } else {
    initialize();
  }

  // Swup 页面切换后重新初始化
  function onSwupPageView() {
    requestAnimationFrame(function() {
      initialize();
    });
  }

  document.addEventListener('page:view', onSwupPageView);
  document.addEventListener('swup:page:view', onSwupPageView); // 兼容旧版手动初始化
})();
<\/script>
`;

    return html + script;
  });

  // ========== 后台编辑器注入 ==========
  const editorUIHtml = `
<div id="livephoto-dialog" class="wmd-prompt-dialog" style="display:none; position:fixed; top:50%; left:50%; z-index:10000; background:#fff; border:1px solid #ccc; border-radius:4px; box-shadow:0 2px 10px rgba(0,0,0,0.2); padding:20px;">
  <div>
    <p><b>插入 Live Photo</b></p>
    <p>请输入图片URL:</p>
    <p><input type="text" id="lp-photo-url" style="width:100%;" placeholder="https://example.com/photo.jpg"></p>
    <p>请输入视频URL:</p>
    <p><input type="text" id="lp-video-url" style="width:100%;" placeholder="https://example.com/video.mp4"></p>
    <p>请输入图片比例(如 3/4):</p>
    <p><input type="text" id="lp-aspect-ratio" style="width:100%;" placeholder="留空默认3/4"></p>
    <p style="margin-top:10px;"></p>
  </div>
  <div style="margin-top:15px; text-align:right;">
    <button type="button" class="btn btn-s primary" id="lp-ok">确定</button>
    <button type="button" class="btn btn-s" id="lp-cancel">取消</button>
  </div>
</div>

<!-- Fallback 容器 -->
<div id="livephoto-fallback-container" style="margin-bottom:8px;"></div>

<script is:inline>
(function() {
  // ---------- 对话框逻辑 ----------
  function initDialog() {
    var dialog = document.getElementById('livephoto-dialog');
    if (!dialog) return;
    var photoInput = document.getElementById('lp-photo-url');
    var videoInput = document.getElementById('lp-video-url');
    var ratioInput = document.getElementById('lp-aspect-ratio');
    var okBtn = document.getElementById('lp-ok');
    var cancelBtn = document.getElementById('lp-cancel');

    function insertLivePhoto() {
      var photo = photoInput.value.trim();
      var video = videoInput.value.trim();
      if (!photo || !video) {
        alert('请填写图片和视频链接');
        return;
      }
      var ratio = ratioInput.value.trim();
      var code = '[LivePhoto photo="' + photo + '" video="' + video + '"';
      if (ratio) {
        code += ' ratio="' + ratio + '"';
      }
      code += ']';

      var editor = document.getElementById('text');
      if (editor && editor.tagName === 'TEXTAREA') {
        var start = editor.selectionStart;
        var end = editor.selectionEnd;
        var text = editor.value;
        editor.value = text.substring(0, start) + code + text.substring(end);
        editor.selectionStart = editor.selectionEnd = start + code.length;
        editor.focus();
      } else {
        alert('未找到可用的编辑器，请确保光标在内容区域');
      }

      dialog.style.display = 'none';
      photoInput.value = '';
      videoInput.value = '';
      ratioInput.value = '';
    }

    okBtn.addEventListener('click', insertLivePhoto);
    cancelBtn.addEventListener('click', function() { dialog.style.display = 'none'; });

    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && dialog.style.display !== 'none') {
        dialog.style.display = 'none';
      }
    });

    [photoInput, videoInput, ratioInput].forEach(function(input) {
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          insertLivePhoto();
        }
      });
    });
  }

  // ---------- 定位逻辑 ----------
  function findWmdButtonRow() {
    var row = document.getElementById('wmd-button-row');
    if (row) return row;
    row = document.querySelector('ul.wmd-button-row');
    if (row) return row;
    var bar = document.getElementById('wmd-button-bar');
    if (bar) {
      row = bar.querySelector('ul.wmd-button-row');
      if (row) return row;
    }
    var uls = document.querySelectorAll('ul');
    for (var i = 0; i < uls.length; i++) {
      if (uls[i].className && uls[i].className.indexOf('wmd-button') !== -1) {
        return uls[i];
      }
    }
    return null;
  }

  var svgIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"><g fill="none" stroke="#999999" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M11 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0"/><path d="M7 12a5 5 0 1 0 10 0a5 5 0 1 0-10 0m8.9 8.11v.01m3.14-2.51v.01M20.77 14v.01m0-4.01v.01m-1.73-3.62v.01M15.9 3.89v.01M12 3v.01m-3.9.88v.01M4.96 6.39v.01M3.23 10v.01m0 3.99v.01m1.73 3.6v.01m3.14 2.49v.01M12 21v.01"/></g></svg>';

  function addLivePhotoButton() {
    var row = findWmdButtonRow();
    if (!row) return false;
    if (document.getElementById('wmd-livephoto-button')) return true;

    var spacer = document.createElement('li');
    spacer.className = 'wmd-spacer';
    row.appendChild(spacer);

    var item = document.createElement('li');
    item.id = 'wmd-livephoto-button';
    item.className = 'wmd-button';
    item.title = '插入 LivePhoto';
    item.setAttribute('aria-label', '插入 LivePhoto');
    item.style.cursor = 'pointer';
    item.style.padding = '4px 4px 0px 4px;';
    item.style.display = 'inline';
    item.style.alignItems = 'center';
    item.style.justifyContent = 'center';
    item.innerHTML = svgIcon;

    item.addEventListener('click', function() {
      var dialog = document.getElementById('livephoto-dialog');
      if (dialog) {
        dialog.style.display = 'block';
        var photoInput = document.getElementById('lp-photo-url');
        if (photoInput) setTimeout(function() { photoInput.focus(); }, 50);
      }
    });

    row.appendChild(item);
    return true;
  }

  function initLivePhotoButton() {
    if (addLivePhotoButton()) return;

    var attempts = 0;
    var timer = setInterval(function() {
      attempts++;
      if (addLivePhotoButton()) {
        clearInterval(timer);
      } else if (attempts >= 100) {
        clearInterval(timer);
        var container = document.getElementById('livephoto-fallback-container');
        if (container && !container.querySelector('.livephoto-fallback-btn')) {
          var fallbackBtn = document.createElement('button');
          fallbackBtn.className = 'livephoto-fallback-btn';
          fallbackBtn.type = 'button';
          fallbackBtn.style.margin = '4px 0';
          fallbackBtn.style.display = 'inline-flex';
          fallbackBtn.style.alignItems = 'center';
          fallbackBtn.style.gap = '4px';
          fallbackBtn.innerHTML = svgIcon + ' Live图';
          fallbackBtn.title = '插入 LivePhoto';
          fallbackBtn.addEventListener('click', function() {
            var dialog = document.getElementById('livephoto-dialog');
            if (dialog) {
              dialog.style.display = 'block';
              var photoInput = document.getElementById('lp-photo-url');
              if (photoInput) setTimeout(function() { photoInput.focus(); }, 50);
            }
          });
          container.appendChild(fallbackBtn);
        }
      }
    }, 100);
  }

  // 初始化
  initDialog();
  initLivePhotoButton();
})();
<\/script>
`;

  addHook('admin:writePost:bottom', pluginId, (html: string) => html + editorUIHtml);
  addHook('admin:writePage:bottom', pluginId, (html: string) => html + editorUIHtml);
}