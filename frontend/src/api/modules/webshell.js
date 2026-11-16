import request from '../request'

export const listWebShellRules = (params) => request.get('/webshell-rules/', { params })
export const createWebShellRule = (data) => request.post('/webshell-rules/', data)
export const updateWebShellRule = (id, data) => request.put(`/webshell-rules/${id}/`, data)
export const patchWebShellRule = (id, data) => request.patch(`/webshell-rules/${id}/`, data)
export const deleteWebShellRule = (id) => request.delete(`/webshell-rules/${id}/`)
export const testWebShellCommand = (command) => request.post('/webshell-rules/test/', { command })
export const getWebShellAudit = (params) => request.get('/webshell-rules/audit/', { params })