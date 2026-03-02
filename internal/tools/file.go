package tools

import "fmt"

// resolveProjectRoot finds a project root path by name or from session.
func (s *Server) resolveProjectRoot(project string) (string, error) {
	if project == "*" || project == "all" {
		return "", fmt.Errorf("cross-project queries are not supported; use list_projects to find a specific project name, or omit the project parameter to use the current session project")
	}

	// Use session root if available and no specific project requested
	if project == "" && s.sessionRoot != "" {
		return s.sessionRoot, nil
	}

	projName := s.resolveProjectName(project)
	if projName == "" {
		return "", fmt.Errorf("no projects indexed")
	}
	if !s.router.HasProject(projName) {
		return "", fmt.Errorf("project %q not found; use list_projects to see available projects", projName)
	}

	st, err := s.router.ForProject(projName)
	if err != nil {
		return "", err
	}

	projects, err := st.ListProjects()
	if err != nil {
		return "", err
	}
	if len(projects) == 0 {
		return "", fmt.Errorf("no projects indexed")
	}
	return projects[0].RootPath, nil
}
