import request from '../request'

export const getPlanningStatus = () => request.get('/planning-status')