import React from 'react';
import './Loader.css'; // We'll add some basic styles here

export default function Loader({ message = "Loading..." }) {
  return (
    <div className="loader-container">
      <div className="spinner"></div>
      <p>{message}</p>
    </div>
  );
}
