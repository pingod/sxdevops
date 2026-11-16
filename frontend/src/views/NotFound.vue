<template>
  <div class="not-found-page">
    <div class="not-found-card">
      <div class="not-found-code">404</div>
      <h1>页面不存在</h1>
      <p>你访问的地址可能已改名或已下线，请检查链接后重试。</p>
      <div class="actions">
        <button type="button" @click="$router.back()">返回上一页</button>
        <button type="button" class="primary" @click="$router.push('/dashboard')">回到工作台</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.not-found-page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: linear-gradient(180deg, #f8fafc 0%, #e2e8f0 100%);
  padding: 24px;
}

.not-found-card {
  width: min(520px, 100%);
  padding: 40px;
  border-radius: 28px;
  background: rgba(255, 255, 255, 0.9);
  box-shadow: 0 24px 60px rgba(15, 23, 42, 0.12);
  text-align: center;
}

.not-found-code {
  font-size: 72px;
  font-weight: 800;
  line-height: 1;
  color: #2563eb;
}

h1 {
  margin: 16px 0 12px;
  color: #0f172a;
}

p {
  margin: 0;
  color: #475569;
}

.actions {
  margin-top: 24px;
  display: flex;
  justify-content: center;
  gap: 12px;
}

.actions button {
  padding: 9px 18px;
  border-radius: 10px;
  border: 1px solid #cbd5e1;
  background: #fff;
  color: #0f172a;
  cursor: pointer;
}

.actions button.primary {
  border-color: #245bdb;
  background: #245bdb;
  color: #fff;
}
</style>
