import React, { useEffect } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import authService from '../services/auth';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requireLevel?: number;
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children, requireLevel = 2 }) => {
  const location = useLocation();
  const isAuthenticated = authService.isAuthenticated();
  const securityLevel = authService.getSecurityLevel();

  // Check if user has required security level (device-verified = full access)
  if (!isAuthenticated || securityLevel < requireLevel) {
    // Redirect to login with return path
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
};

export default ProtectedRoute;