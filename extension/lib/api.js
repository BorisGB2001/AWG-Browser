/* Message helper for popup/options pages. */
"use strict";

async function api(type, args = {}) {
  const res = await browser.runtime.sendMessage({ type, ...args });
  if (!res) throw new Error("Фоновый скрипт не ответил.");
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

function fmtBytes(n) {
  if (!n) return "0 Б";
  const u = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return n.toFixed(i ? 1 : 0) + " " + u[i];
}

function fmtAgo(sec) {
  if (!sec) return "нет";
  const d = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (d < 60) return d + " с назад";
  if (d < 3600) return Math.floor(d / 60) + " мин назад";
  return Math.floor(d / 3600) + " ч назад";
}
