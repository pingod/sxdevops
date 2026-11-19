import request from '@/api/request'

// ====== 巡检总览 ======
export const getInspectionOverview = () => request.get('/inspections/overview/')

// ====== 巡检项目录 ======
export const getInspectionItems = (params = {}) => request.get('/inspections/items/', { params })
export const updateInspectionItem = (id, data) => request.patch(`/inspections/items/${id}/`, data)

// ====== 巡检计划 ======
export const getInspectionPlans = (params = {}) => request.get('/inspections/plans/', { params })
export const createInspectionPlan = (data) => request.post('/inspections/plans/', data)
export const updateInspectionPlan = (id, data) => request.put(`/inspections/plans/${id}/`, data)
export const deleteInspectionPlan = (id) => request.delete(`/inspections/plans/${id}/`)
export const runInspectionPlanNow = (id) => request.post(`/inspections/plans/${id}/run_now/`)
export const toggleInspectionPlan = (id) => request.post(`/inspections/plans/${id}/toggle_enabled/`)
export const previewInspectionPlanRuns = (id, count = 5) => request.get(`/inspections/plans/${id}/preview_next_runs/`, { params: { count } })

// ====== 巡检执行 ======
export const getInspectionRuns = (params = {}, signal) => request.get('/inspections/runs/', { params, signal })
export const getInspectionRun = (id) => request.get(`/inspections/runs/${id}/`)
export const rerunInspectionRun = (id) => request.post(`/inspections/runs/${id}/rerun/`)
export const analyzeInspectionRun = (id, force = false) => request.post(`/inspections/runs/${id}/analyze/`, { force })
export const getInspectionReport = (id) => request.get(`/inspections/runs/${id}/report/`)

// ====== 隐患台账 ======
export const getInspectionIssues = (params = {}, signal) => request.get('/inspections/issues/', { params, signal })
export const updateInspectionIssueStatus = (id, action) => request.post(`/inspections/issues/${id}/${action}/`)

// ====== AI 推荐巡检项 ======
export const recommendInspectionItems = (data) => request.post('/inspections/recommend-items/', data, { timeout: 60000 })
