'use strict';
const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['po_api_key'], ({ po_api_key }) => {
    $('key').value = po_api_key ?? '';
  });
  $('save').addEventListener('click', () => {
    chrome.storage.local.set({ po_api_key: $('key').value.trim() }, () => {
      $('saved').textContent = '已保存 ✓';
      setTimeout(() => { $('saved').textContent = ''; }, 1500);
    });
  });
});
