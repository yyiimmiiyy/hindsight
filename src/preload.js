'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('hindsight', {
  getSettings: call('settings:get'),
  saveSettings: call('settings:save'),
  listPulls: call('pulls:list'),
  runReview: call('review:run'),
  postReview: call('review:post'),
  proposeLesson: call('lesson:propose'),
  listLessons: call('lessons:list'),
  addLesson: call('lessons:add'),
  updateLesson: call('lessons:update'),
  removeLesson: call('lessons:remove'),
  exportLessons: call('lessons:export'),
  importLessons: call('lessons:import'),
  openExternal: call('open:external')
});
